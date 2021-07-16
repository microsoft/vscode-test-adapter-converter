/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  TestAdapter,
  TestEvent,
  TestInfo,
  TestRunStartedEvent,
  TestSuiteInfo
} from 'vscode-test-adapter-api';

export const metadata = new WeakMap<vscode.TestItem, ITestMetadata>();

export interface ITestMetadata {
  converter: TestConverter;
}

let rootIdCounter = 0;

export class TestConverter implements vscode.Disposable {
  public readonly root: vscode.TestItem;

  private readonly itemsById = new Map<string, vscode.TestItem>();
  private readonly tasksByRunId = new Map<string, vscode.TestRun>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly adapter: TestAdapter, private readonly ctrl: vscode.TestController) {
    this.root = vscode.test.createTestItem(
      `test-adapter-root-${rootIdCounter++}`,
      'Test Adapter',
      undefined
    );
    ctrl.items.add(this.root);
    metadata.set(this.root, { converter: this });
    this.itemsById.set(this.root.id, this.root);

    this.disposables.push(
      { dispose: () => ctrl.items.delete(this.root.id) },

      adapter.tests(evt => {
        switch (evt.type) {
          case 'finished':
            this.root.busy = false;
            if (evt.suite) {
              this.root.label = evt.suite.label;
              this.syncItemChildren(this.root, evt.suite.children);
              promptDisableExplorerUi(); // prompt the first time we discover tests
            }
            break;
          case 'started':
            this.root.busy = true;
            break;
        }
      }),
      adapter.testStates(evt => {
        const task = this.tasksByRunId.get(evt.testRunId ?? '');
        if (!task) {
          return;
        }

        switch (evt.type) {
          case 'test':
            return this.onTestEvent(task, evt);
          case 'suite':
            return; // no-op, suite state is automatically derived from test state
          case 'finished':
            return task.end();
        }
      })
    );

    setTimeout(() => this.adapter.load(), 1);
  }

  public async refresh() {
    this.root.busy = true;
    await this.adapter.load();
    this.root.busy = false;
  }

  public dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  public async run(
    run: vscode.TestRun,
    testsToRun: readonly vscode.TestItem[] | undefined,
    debug: boolean,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!testsToRun || testsToRun.includes(this.root)) {
      testsToRun = [...this.root.children];
    }

    let listener: vscode.Disposable;
    const started = await new Promise<TestRunStartedEvent | undefined>(resolve => {
      listener = this.adapter.testStates(evt => {
        if (evt.type === 'started') {
          resolve(evt);
          listener.dispose();
        }
      });

      if (!debug) {
        this.adapter.run(testsToRun!.map(t => t.id));
      } else if (this.adapter.debug) {
        this.adapter.debug(testsToRun!.map(t => t.id));
      } else {
        resolve(undefined);
      }
    }).finally(() => listener.dispose());

    if (!started) {
      return;
    }
    const queue: Iterable<vscode.TestItem>[] = [testsToRun];
    while (queue.length) {
      for (const test of queue.pop()!) {
        run.setState(test, vscode.TestResultState.Queued);
        queue.push(test.children);
      }
    }

    this.tasksByRunId.set(started.testRunId ?? '', run);
    token.onCancellationRequested(() => this.adapter.cancel());
  }

  /**
   * Ensures the given children are set as the children of the test item.
   */
  private syncItemChildren(parentTest: vscode.TestItem, children: (TestSuiteInfo | TestInfo)[]) {
    parentTest.children.set(children.map(item => {
      const childTest = vscode.test.createTestItem(
        item.id,
        item.label,
        item.file ? fileToUri(item.file) : parentTest.uri
      );
      metadata.set(childTest, { converter: this });
      this.itemsById.set(item.id, childTest);
      childTest.description = item.description;

      if (item.line !== undefined) {
        childTest.range = new vscode.Range(item.line, 0, item.line + 1, 0);
      }

      if (item.errored) {
        childTest.error = item.message;
      }

      if ('children' in item) {
        this.syncItemChildren(childTest, item.children);
      }

      return childTest;
    }));
  }

  /**
   * TestEvent handler.
   */
  private onTestEvent(task: vscode.TestRun, evt: TestEvent) {
    const id = typeof evt.test === 'string' ? evt.test : evt.test.id;
    const vscodeTest = this.itemsById.get(id);
    if (!vscodeTest) {
      return;
    }

    if (evt.message) {
      const message = new vscode.TestMessage(evt.message);
      message.severity = vscode.TestMessageSeverity.Information;
      task.appendMessage(vscodeTest, message);
    }

    for (const decoration of evt.decorations ?? []) {
      const message = new vscode.TestMessage(decoration.message);
      const uri = decoration.file ? fileToUri(decoration.file) : vscodeTest.uri;
      if (uri) {
        message.location = new vscode.Location(uri, new vscode.Position(decoration.line, 0));
      }

      task.appendMessage(vscodeTest, message);
    }

    task.setState(vscodeTest, convertedStates[evt.state]);
  }
}

const schemeMatcher = /^[a-z][a-z0-9+-.]+:/;
const fileToUri = (file: string) =>
  schemeMatcher.test(file) ? vscode.Uri.parse(file) : vscode.Uri.file(file);

const convertedStates = {
  running: vscode.TestResultState.Running,
  passed: vscode.TestResultState.Passed,
  failed: vscode.TestResultState.Failed,
  skipped: vscode.TestResultState.Skipped,
  errored: vscode.TestResultState.Errored,
  completed: vscode.TestResultState.Unset,
};

const settings = [
  'testExplorer.gutterDecoration',
  'testExplorer.codeLens',
  'testExplorer.errorDecoration',
  'testExplorer.errorDecorationHover',
];

let shouldPromptForUiDisable = vscode.workspace.getConfiguration().get(settings[0]) !== false;

const promptDisableExplorerUi = async () => {
  if (!shouldPromptForUiDisable) {
    return;
  }

  shouldPromptForUiDisable = false;
  const yes = 'Yes';
  const workspace = 'Only in this Workspace';
  const no = 'No';

  const result = await vscode.window.showInformationMessage(
    'Thanks for trying out native VS Code testing! Would you like to disable the default Test Explorer extension UI?',
    no,
    yes,
    workspace
  );

  if (result === yes || result === workspace) {
    const target =
      result === yes ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    const config = vscode.workspace.getConfiguration();
    for (const setting of settings) {
      config.update(setting, false, target);
    }
  }
};

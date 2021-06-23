/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  TestAdapter,
  TestEvent,
  TestInfo,
  TestRunStartedEvent,
  TestSuiteInfo,
} from 'vscode-test-adapter-api';

let generationCounter = 0;

export interface ITestMetadata {
  converter: TestConverter;
  generation: number;
}

let rootIdCounter = 0;

export class TestConverter implements vscode.Disposable {
  public readonly root: vscode.TestItem<ITestMetadata>;

  private readonly itemsById = new Map<string, vscode.TestItem<ITestMetadata>>();
  private readonly tasksByRunId = new Map<string, vscode.TestRun<ITestMetadata>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly adapter: TestAdapter,
    private readonly ctrl: vscode.TestController<ITestMetadata>
  ) {
    this.root = this.ctrl.createTestItem<ITestMetadata>(
      `test-adapter-root-${rootIdCounter++}`,
      'Test Adapter',
      this.ctrl.root,
      undefined,
      { generation: 0, converter: this }
    );
    this.root.debuggable = true;

    this.itemsById.set(this.root.id, this.root);

    this.disposables.push(
      this.root,

      adapter.tests(evt => {
        switch (evt.type) {
          case 'finished':
            this.root.busy = false;
            if (evt.suite) {
              this.syncItemChildren(this.root, generationCounter++, [evt.suite]);
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

    if (adapter.retire) {
      this.disposables.push(
        adapter.retire(evt => {
          for (const test of evt.tests ?? [this.root.id]) {
            this.itemsById.get(test)?.invalidate();
          }
        })
      );
    }

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
    run: vscode.TestRun<ITestMetadata>,
    testsToRun: vscode.TestItem<ITestMetadata>[],
    debug: boolean,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (testsToRun.includes(this.root)) {
      testsToRun = [...this.root.children.values()];
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
        this.adapter.run(testsToRun.map(t => t.id));
      } else if (this.adapter.debug) {
        this.adapter.debug(testsToRun.map(t => t.id));
      } else {
        resolve(undefined);
      }
    }).finally(() => listener.dispose());

    if (!started) {
      return;
    }
    const queue: Iterable<vscode.TestItem<ITestMetadata>>[] = [testsToRun];
    while (queue.length) {
      for (const test of queue.pop()!) {
        run.setState(test, vscode.TestResultState.Queued);
        queue.push(test.children.values());
      }
    }

    this.tasksByRunId.set(started.testRunId ?? '', run);
    token.onCancellationRequested(() => this.adapter.cancel());
  }

  /**
   * Recursively adds an item and its children from the adapter into the VS
   * Code test tree.
   */
  private addItem(
    item: TestSuiteInfo | TestInfo,
    generation: number,
    parent: vscode.TestItem<ITestMetadata>
  ) {
    let vscodeTest = parent.children.get(item.id) as vscode.TestItem<ITestMetadata> | undefined;
    if (vscodeTest) {
      vscodeTest.data.generation = generation;
    } else {
      vscodeTest = this.ctrl.createTestItem<ITestMetadata>(
        item.id,
        item.label,
        parent,
        item.file ? fileToUri(item.file) : parent.uri,
        {
          converter: this,
          generation,
        }
      );

      this.itemsById.set(item.id, vscodeTest);
    }

    vscodeTest.description = item.description;

    if (item.line !== undefined) {
      vscodeTest.range = new vscode.Range(item.line, 0, item.line + 1, 0);
    }

    vscodeTest.description = item.description;
    vscodeTest.debuggable = !!this.adapter.debug;

    if (item.errored) {
      vscodeTest.error = item.message;
    }

    this.syncItemChildren(vscodeTest, generation, 'children' in item ? item.children : []);
    return vscodeTest;
  }

  /**
   * Ensures the given children are set as the children of the test item.
   */
  private syncItemChildren(
    vscodeTest: vscode.TestItem<ITestMetadata>,
    generation: number,
    children: Iterable<TestSuiteInfo | TestInfo>
  ) {
    for (const child of children) {
      this.addItem(child, generation, vscodeTest);
    }

    for (const child of vscodeTest.children.values()) {
      if (child.data.generation !== generation) {
        child.dispose();
        this.itemsById.delete(child.id);
      }
    }
  }

  /**
   * TestEvent handler.
   */
  private onTestEvent(task: vscode.TestRun<ITestMetadata>, evt: TestEvent) {
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

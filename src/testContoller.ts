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

interface IMetadata {
  generation: number;
}

type ConverterTestItem = vscode.TestItem<IMetadata>;

let rootIdCounter = 0;

export class TestController implements vscode.TestController<IMetadata> {
  private readonly root: ConverterTestItem = vscode.test.createTestItem(
    {
      id: `test-adapter-root-${rootIdCounter++}`,
      label: 'Test Adapter',
      uri:
        this.adapter.workspaceFolder?.uri ??
        vscode.workspace.workspaceFolders?.[0]?.uri ??
        vscode.Uri.file('/'),
    },
    { generation: 0 }
  );

  private readonly itemsById = new Map<string, ConverterTestItem>([[this.root.id, this.root]]);
  private readonly tasksByRunId = new Map<string, vscode.TestRun<IMetadata>>();
  private readonly disposables: vscode.Disposable[] = [];
  private hasRequestedLoad = false;

  constructor(private readonly adapter: TestAdapter) {
    this.disposables.push(
      adapter.tests(evt => {
        if (evt.type !== 'finished') {
          return;
        }

        if (evt.suite) {
          this.syncItemChildren(this.root, generationCounter++, [evt.suite]);
          promptDisableExplorerUi(); // prompt the first time we discover tests
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
  }

  /**
   * @inheritdoc
   */
  public createWorkspaceTestRoot(workspace: vscode.WorkspaceFolder): ConverterTestItem | undefined {
    // Return nothing if the adapter is tied to a different workspace folder,
    // or if it's not tied to a folder and this isn't the first folder
    // (show tests there arbitrarily)
    if (this.adapter.workspaceFolder) {
      if (workspace !== this.adapter.workspaceFolder) {
        return undefined;
      }
    } else if (workspace !== vscode.workspace.workspaceFolders?.[0]) {
      return undefined;
    }

    if (!this.hasRequestedLoad) {
      this.adapter.load();
      this.hasRequestedLoad = true;
    }

    return this.root;
  }

  /**
   * @inheritdoc
   */
  public async runTests(
    options: vscode.TestRunRequest<IMetadata>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const tests =
      options.tests.length === 1 && options.tests[0] === this.root
        ? [...this.root.children.values()]
        : options.tests;

    let listener: vscode.Disposable;
    const started = await new Promise<TestRunStartedEvent | undefined>(resolve => {
      listener = this.adapter.testStates(evt => {
        if (evt.type === 'started') {
          resolve(evt);
          listener.dispose();
        }
      });

      if (!options.debug) {
        this.adapter.run(tests.map(t => t.id));
      } else if (this.adapter.debug) {
        this.adapter.debug(tests.map(t => t.id));
      } else {
        resolve(undefined);
      }
    }).finally(() => listener.dispose());

    if (!started) {
      return;
    }

    const task = vscode.test.createTestRun(options);
    const queue: Iterable<ConverterTestItem>[] = [tests];
    while (queue.length) {
      for (const test of queue.pop()!) {
        task.setState(test, vscode.TestResultState.Queued);
        queue.push(test.children.values());
      }
    }

    this.tasksByRunId.set(started.testRunId ?? '', task);
    token.onCancellationRequested(() => this.adapter.cancel());
  }

  /**
   * Recursively adds an item and its children from the adapter into the VS
   * Code test tree.
   */
  private addItem(item: TestSuiteInfo | TestInfo, generation: number, parent: ConverterTestItem) {
    let vscodeTest = parent.children.get(item.id) as ConverterTestItem | undefined;
    if (vscodeTest) {
      vscodeTest.data.generation = generation;
    } else {
      vscodeTest = vscode.test.createTestItem(
        {
          id: item.id,
          label: item.label,
          uri: item.file ? fileToUri(item.file) : parent.uri,
        },
        {
          generation,
        }
      );

      this.itemsById.set(item.id, vscodeTest);
      parent.addChild(vscodeTest);
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
    vscodeTest: ConverterTestItem,
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
  private onTestEvent(task: vscode.TestRun<IMetadata>, evt: TestEvent) {
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
      message.location = new vscode.Location(
        decoration.file ? fileToUri(decoration.file) : vscodeTest.uri,
        new vscode.Position(decoration.line, 0)
      );

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

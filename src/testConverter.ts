/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ansiColors from 'ansi-colors';
import { parse as parseStack } from 'stacktrace-parser';
import * as vscode from 'vscode';
import {
  TestAdapter,
  TestEvent,
  TestInfo,
  TestLoadFinishedEvent,
  TestSuiteEvent,
  TestSuiteInfo,
} from 'vscode-test-adapter-api';

export const metadata = new WeakMap<vscode.TestItem, ITestMetadata>();

export interface ITestMetadata {
  isSuite: boolean;
  converter: TestConverter;
}

const unique = <T, R>(arr: readonly T[], project: (v: T) => R): T[] => {
  const seen = new Set<R>();
  return arr.filter(t => {
    const r = project(t);
    if (seen.has(r)) {
      return false;
    }

    seen.add(r);
    return true;
  });
};

const testViewId = 'workbench.view.extension.test';
let nextControllerId = 1;

const getControllerName = () => {
  /* The test explorer extension doesn't tell us the name of the controller
  creating the profiles. But, it is in the stacktrace! So try to parse it out. Example:

  Error:
    at eval (eval-5a7aa349.repl:1:1)
    at new TestConverter (c:\\Users\\conno\\Github\\vscode-test-adapter-converter\\out\\extension.js:142:5)
    at TestConverterFactory.registerTestAdapter (c:\\Users\\conno\\Github\\vscode-test-adapter-converter\\out\\extension.js:415:34)
    at TestHub.registerTestAdapter (c:\\Users\\conno\\.vscode-insiders\\extensions\\hbenl.vscode-test-explorer-2.22.1\\out\\hub\\testHub.js:42:24)
    at Object.registerTestAdapter (c:\\Users\\conno\\.vscode-insiders\\extensions\\hbenl.vscode-test-explorer-2.22.1\\out\\main.js:106:45)
    at TestAdapterRegistrar.add (c:\\Users\\conno\\.vscode-insiders\\extensions\\hbenl.vscode-mocha-test-adapter-2.14.1\\node_modules\\vscode-test-adapter-util\\out\\registrar.js:48:22)
    at new TestAdapterRegistrar (c:\\Users\\conno\\.vscode-insiders\\extensions\\hbenl.vscode-mocha-test-adapter-2.14.1\\node_modules\\vscode-test-adapter-util\\out\\registrar.js:19:22)
  */

  const stack = parseStack(new Error().stack || '');
  for (const frame of stack) {
    if (!frame.file) {
      continue;
    }

    const parts = frame.file.split(/[\\/]/g);
    const extensionsIndex = parts.indexOf('extensions');
    if (extensionsIndex === -1) {
      continue;
    }

    const extensionAndVersionPart = parts[extensionsIndex + 1];
    const extensionId = extensionAndVersionPart.replace(/-[\d.]+$/, '');
    if (
      extensionId.includes('vscode-test-explorer') ||
      extensionId.includes('test-adapter-converter')
    ) {
      continue;
    }

    return extensionId;
  }

  return 'Test Adapter Converter';
};

interface IRunningTaskData {
  task: vscode.TestRun;
  announcedTests: Set<vscode.TestItem>;
}

export class TestConverter implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private doneDiscovery?: () => void;
  private readonly itemsById = new Map<string, vscode.TestItem>();
  private readonly tasksByRunId = new Map<string, IRunningTaskData>();
  private readonly runningSuiteByRunId = new Map<string, vscode.TestItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private _error?: string;

  public get error() {
    return this._error;
  }

  public get controllerId() {
    return this.controller.id;
  }

  constructor(private readonly adapter: TestAdapter) {
    this.controller = vscode.tests.createTestController(
      `test-adapter-ctrl-${nextControllerId++}`,
      getControllerName()
    );
    this.controller.refreshHandler = () => this.adapter.load();
    this.disposables.push(this.controller);

    const makeRunHandler =
      (debug: boolean) => (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
        if (request.continuous && adapter.retire) {
          const disposables = [
            adapter.retire(evt => {
              runOrDebug(
                debug,
                request,
                evt.tests?.map(id => this.itemsById.get(id)).filter(d => !!d),
                token
              );
            }),
            token.onCancellationRequested(() => disposables.forEach(d => d.dispose())),
          ];
        } else {
          runOrDebug(debug, request, request.include, token);
        }
      };

    const runOrDebug = (
      debug: boolean,
      request: vscode.TestRunRequest,
      include: readonly vscode.TestItem[] | undefined,
      token: vscode.CancellationToken
    ) => {
      if (!include) {
        this.run(this.controller.createTestRun(request), include, debug, token);
        return;
      }

      const involved = new Map<TestConverter, vscode.TestItem[]>();
      for (const test of include) {
        const converter = metadata.get(test)!.converter;
        const i = involved.get(converter);
        if (i) {
          i.push(test);
        } else {
          involved.set(converter, [test]);
        }
      }

      for (const [converter, tests] of involved) {
        converter.run(this.controller.createTestRun(request), tests, debug, token);
      }
    };

    const run = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      makeRunHandler(false),
      true
    );
    run.supportsContinuousRun = !!adapter.retire;

    const debug = this.controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      makeRunHandler(true),
      true
    );
    debug.supportsContinuousRun = !!adapter.retire;

    this.disposables.push(
      adapter.tests(evt => {
        switch (evt.type) {
          case 'finished':
            this.doneDiscovery?.();
            this.doneDiscovery = undefined;
            this.itemsById.clear();
            this.syncTopLevel(evt);
            break;

          case 'started':
            if (!this.doneDiscovery) {
              vscode.window.withProgress(
                { title: `An adapter is discovering tests`, location: { viewId: testViewId } },
                () =>
                  new Promise<void>(resolve => {
                    this.doneDiscovery = resolve;
                    // Avoid showing "busy" if discovery is blocked, e.g. on a notification
                    // See https://github.com/microsoft/vscode/issues/178232
                    setTimeout(resolve, 30_000);
                  })
              );
            }
            break;
        }
      }),
      adapter.testStates(evt => {
        const data = this.tasksByRunId.get(evt.testRunId ?? '');
        if (!data) {
          return;
        }

        switch (evt.type) {
          case 'test':
            return this.onTestEvent(data, evt);
          case 'suite':
            return this.onTestSuiteEvent(evt);
          case 'finished':
            this.tasksByRunId.delete(evt.testRunId ?? '');
            return data.task.end();
        }
      })
    );
    if (adapter.retire) {
      this.disposables.push(
        adapter.retire(evt => {
          if (evt.tests) {
            const items = evt.tests.map(test => this.itemsById.get(test)).filter(item => !!item);
            this.controller.invalidateTestResults(items);
          } else {
            this.controller.invalidateTestResults();
          }
        })
      );
    }
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
    if (!this.controller) {
      return;
    }

    if (!testsToRun) {
      testsToRun = gatherChildren(this.controller.items);
    }

    const listener = this.adapter.testStates(evt => {
      if (evt.type !== 'started') {
        return;
      }

      const queue: Iterable<vscode.TestItem>[] = [testsToRun!];
      while (queue.length) {
        for (const test of queue.pop()!) {
          if (!metadata.get(test)?.isSuite) {
            run.enqueued(test);
          }
          queue.push(gatherChildren(test.children));
        }
      }

      this.tasksByRunId.set(evt.testRunId ?? '', { task: run, announcedTests: new Set() });
      token.onCancellationRequested(() => this.adapter.cancel());
      listener.dispose();
    });

    if (!debug) {
      this.adapter.run(testsToRun!.map(t => t.id));
    } else if (this.adapter.debug) {
      this.adapter.debug(testsToRun!.map(t => t.id));
    } else {
      listener.dispose();
    }
  }

  private syncTopLevel(evt: TestLoadFinishedEvent) {
    vscode.commands.executeCommand('setContext', 'hasTestConverterTests', true);
    if (evt.suite) {
      this.controller.label = this.adapter.workspaceFolder
        ? `${this.adapter.workspaceFolder.name} - ${evt.suite.label}`
        : evt.suite.label;
      this.syncItemChildren(this.controller.items, evt.suite.children);
    } else if (evt.errorMessage) {
      const test = this.controller.createTestItem('error', 'Test discovery failed');
      this._error =
        evt.errorMessage + '\n\n\n' + new Error().stack?.replace('Error:', 'Stacktrace:');
      test.error = new vscode.MarkdownString(
        `[View details](command:testExplorerConverter.showError?${encodeURIComponent(
          JSON.stringify([this.controllerId])
        )})`
      );
      test.error.isTrusted = true;
      this.controller.items.replace([test]);
    }
  }

  /**
   * Ensures the given children are set as the children of the test item.
   */
  private syncItemChildren(
    collection: vscode.TestItemCollection,
    children: (TestSuiteInfo | TestInfo)[],
    defaultUri?: vscode.Uri
  ) {
    collection.replace(unique(children, c => c.id).map(item => this.createTest(item, defaultUri)));
  }

  private createTest(item: TestSuiteInfo | TestInfo, defaultUri?: vscode.Uri) {
    const test = this.controller.createTestItem(
      item.id,
      item.label,
      item.file ? fileToUri(item.file) : defaultUri
    );
    metadata.set(test, { isSuite: item.type === 'suite', converter: this });
    this.itemsById.set(item.id, test);
    test.description = item.description;

    if (item.line !== undefined) {
      test.range = new vscode.Range(item.line, 0, item.line + 1, 0);
    }

    if (item.errored) {
      test.error = item.message;
    }

    if ('children' in item) {
      this.syncItemChildren(test.children, item.children);
    }

    return test;
  }

  private onTestSuiteEvent(evt: TestSuiteEvent) {
    const runId = evt.testRunId ?? '';
    const runningSuite = this.runningSuiteByRunId.get(runId);
    const suiteId = typeof evt.suite === 'string' ? evt.suite : evt.suite.id;
    if (evt.state === 'running') {
      if (!this.itemsById.has(suiteId) && typeof evt.suite === 'object' && runningSuite) {
        runningSuite.children.add(this.createTest(evt.suite));
      }
      if (this.itemsById.has(suiteId)) {
        this.runningSuiteByRunId.set(runId, this.itemsById.get(suiteId)!);
      }
    } else {
      if (runningSuite && runningSuite.id === suiteId) {
        if (runningSuite.parent) {
          this.runningSuiteByRunId.set(runId, runningSuite.parent);
        } else {
          this.runningSuiteByRunId.delete(runId);
        }
      }
    }
  }

  /**
   * TestEvent handler.
   */
  private onTestEvent({ task, announcedTests }: IRunningTaskData, evt: TestEvent) {
    const runningSuite = this.runningSuiteByRunId.get(evt.testRunId ?? '');
    const testId = typeof evt.test === 'string' ? evt.test : evt.test.id;
    if (
      evt.state === 'running' &&
      !this.itemsById.has(testId) &&
      typeof evt.test === 'object' &&
      runningSuite
    ) {
      runningSuite.children.add(this.createTest(evt.test));
    }
    const vscodeTest = this.itemsById.get(testId);
    if (!vscodeTest) {
      return;
    }

    switch (evt.state) {
      case 'skipped':
        this.appendState(task, vscodeTest, '○', ansiColors.yellow, ansiColors.dim);
        task.skipped(vscodeTest);
        break;
      case 'running':
        task.started(vscodeTest);
        break;
      case 'passed':
        this.ensureChainAnnounced(task, announcedTests, vscodeTest);
        this.appendState(task, vscodeTest, '✔', ansiColors.green);
        task.passed(vscodeTest);
        break;
      case 'errored':
      case 'failed':
        this.ensureChainAnnounced(task, announcedTests, vscodeTest);
        this.appendState(task, vscodeTest, '✖', ansiColors.red, ansiColors.red);

        const messages: vscode.TestMessage[] = [];
        if (evt.message) {
          task.appendOutput(evt.message.replace(/\r?\n/g, '\r\n'), undefined, vscodeTest);
          if (!evt.decorations?.length) {
            const message = new vscode.TestMessage(evt.message);
            messages.push(message);
          }
        }

        for (const decoration of evt.decorations ?? []) {
          const message = new vscode.TestMessage(decoration.message);
          const uri = decoration.file ? fileToUri(decoration.file) : vscodeTest.uri;
          if (uri) {
            message.location = new vscode.Location(uri, new vscode.Position(decoration.line, 0));
          }

          messages.push(message);
        }

        task[evt.state](vscodeTest, messages);
        break;
    }

    if (evt.message && ((evt.state !== 'errored' && evt.state !== 'failed') || !vscodeTest.uri)) {
      task.appendOutput(evt.message.replace(/\r?\n/g, '\r\n'));
    }
  }

  private ensureChainAnnounced(
    task: vscode.TestRun,
    announcedTests: Set<vscode.TestItem>,
    leafTest: vscode.TestItem
  ) {
    const chain: vscode.TestItem[] = [];
    for (
      let item: vscode.TestItem | undefined = leafTest;
      item && !announcedTests.has(item);
      item = item.parent
    ) {
      chain.unshift(item);
    }

    for (const item of chain) {
      announcedTests.add(item);
      if (item.children.size) {
        this.appendState(task, item, '▼', ansiColors.green);
      }
    }
  }

  private appendState(
    task: vscode.TestRun,
    vscodeTest: vscode.TestItem,
    symbol: string,
    symbolColor: (s: string) => string,
    textColor: (s: string) => string = s => s
  ) {
    let indent = '';
    for (let parent = vscodeTest.parent; parent; parent = parent.parent) {
      indent += '  ';
    }
    task.appendOutput(indent + symbolColor(symbol) + textColor(` ${vscodeTest.label}\r\n`));
  }
}

const gatherChildren = (col: vscode.TestItemCollection) => {
  const children: vscode.TestItem[] = [];
  col.forEach(child => children.push(child));
  return children;
};

const schemeMatcher = /^[a-z][a-z0-9+-.]+:/;
const fileToUri = (file: string) =>
  schemeMatcher.test(file) ? vscode.Uri.parse(file) : vscode.Uri.file(file);

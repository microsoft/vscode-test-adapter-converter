/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestEvent, TestInfo, TestSuiteInfo } from 'vscode-test-adapter-api';

export const metadata = new WeakMap<vscode.TestItem, ITestMetadata>();

export interface ITestMetadata {
  converter: TestConverter;
}

const testViewId = 'workbench.view.extension.test';

export class TestConverter implements vscode.Disposable {
  private controller?: vscode.TestController;
  private doneDiscovery?: () => void;
  private readonly itemsById = new Map<string, vscode.TestItem>();
  private readonly tasksByRunId = new Map<string, vscode.TestRun>();
  private readonly disposables: vscode.Disposable[] = [];

  public get controllerId() {
    return this.controller?.id;
  }

  constructor(private readonly adapter: TestAdapter) {
    this.disposables.push(
      adapter.tests(evt => {
        switch (evt.type) {
          case 'finished':
            this.doneDiscovery?.();
            this.doneDiscovery = undefined;
            if (evt.suite) {
              this.syncTopLevel(evt.suite);
            }
            break;

          case 'started':
            if (!this.doneDiscovery) {
              vscode.window.withProgress(
                { location: { viewId: testViewId } },
                () =>
                  new Promise<void>(resolve => {
                    this.doneDiscovery = resolve;
                  })
              );
            }
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
    await vscode.window.withProgress({ location: { viewId: testViewId } }, () =>
      this.adapter.load()
    );
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
          run.enqueued(test);
          queue.push(gatherChildren(test.children));
        }
      }

      this.tasksByRunId.set(evt.testRunId ?? '', run);
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

  private syncTopLevel(suite: TestSuiteInfo) {
    const ctrl = this.acquireController(suite.label);
    this.syncItemChildren(ctrl, ctrl.items, suite.children);
  }

  /**
   * Ensures the given children are set as the children of the test item.
   */
  private syncItemChildren(
    controller: vscode.TestController,
    collection: vscode.TestItemCollection,
    children: (TestSuiteInfo | TestInfo)[],
    defaultUri?: vscode.Uri
  ) {
    collection.replace(
      children.map(item => {
        const childTest = controller.createTestItem(
          item.id,
          item.label,
          item.file ? fileToUri(item.file) : defaultUri
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
          this.syncItemChildren(controller, childTest.children, item.children);
        }

        return childTest;
      })
    );
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

    switch (evt.state) {
      case 'skipped':
        task.skipped(vscodeTest);
        break;
      case 'running':
        task.started(vscodeTest);
        break;
      case 'passed':
        task.passed(vscodeTest);
        break;
      case 'errored':
      case 'failed':
        const messages: vscode.TestMessage[] = [];
        if (evt.message) {
          const message = new vscode.TestMessage(evt.message);
          messages.push(message);
        }

        for (const decoration of evt.decorations ?? []) {
          const message = new vscode.TestMessage(decoration.message);
          const uri = decoration.file ? fileToUri(decoration.file) : vscodeTest.uri;
          if (uri) {
            message.location = new vscode.Location(uri, new vscode.Position(decoration.line, 0));
          }

          messages.push(message);
        }

        task.failed(vscodeTest, messages);
        break;
    }
  }

  private acquireController(label: string) {
    if (this.controller) {
      this.controller.label = label;
      return this.controller;
    }

    let id = `test-adapter-ctrl-${label}`;
    if (this.adapter.workspaceFolder) {
      id += `-${this.adapter.workspaceFolder.uri.toString()}`
    }
    const ctrl = (this.controller = vscode.tests.createTestController(id, label));
    this.disposables.push(ctrl);

    const makeRunHandler = (debug: boolean) => (
      request: vscode.TestRunRequest,
      token: vscode.CancellationToken
    ) => {
      if (!request.include) {
        this.run(ctrl.createTestRun(request), request.include, debug, token);
        return;
      }

      const involved = new Map<TestConverter, vscode.TestItem[]>();
      for (const test of request.include) {
        const converter = metadata.get(test)!.converter;
        const i = involved.get(converter);
        if (i) {
          i.push(test);
        } else {
          involved.set(converter, [test]);
        }
      }

      for (const [converter, tests] of involved) {
        converter.run(ctrl.createTestRun(request), tests, debug, token);
      }
    };

    ctrl.createRunProfile('Run', vscode.TestRunProfileKind.Run, makeRunHandler(false), true);
    ctrl.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, makeRunHandler(true), true);
    vscode.commands.executeCommand('setContext', 'hasTestConverterTests', true);

    return ctrl;
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

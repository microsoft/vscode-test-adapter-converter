/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as AdapterTestController } from 'vscode-test-adapter-api';
import { ITestMetadata, TestConverter } from './testConverter';

export class TestConverterFactory implements AdapterTestController, vscode.Disposable {
  private readonly converters = new Map<TestAdapter, TestConverter>();
  private ctrl?: vscode.TestController;

  /**
   * @inheritdoc
   */
  registerTestAdapter(adapter: TestAdapter): void {
    this.ctrl ??= this.makeTestController();
    this.converters.set(adapter, new TestConverter(adapter, this.ctrl));
  }

  /**
   * @inheritdoc
   */
  unregisterTestAdapter(adapter: TestAdapter): void {
    this.converters.get(adapter)?.dispose();
    this.converters.delete(adapter);
  }

  /**
   * @inheritdoc
   */
  dispose() {
    this.ctrl?.dispose();
    for (const disposables of this.converters.values()) {
      disposables.dispose();
    }
  }

  public refresh(testId?: string) {
    for (const converter of this.converters.values()) {
      if (!testId || converter.root.id === testId) {
        converter.refresh();
      }
    }
  }

  private makeTestController() {
    const ctrl = vscode.test.createTestController<ITestMetadata>(
      'ms-vscode.test-adapter-converter'
    );
    ctrl.root.label = 'Test Adapter Converter';
    ctrl.root.debuggable = true;

    ctrl.runHandler = (request, token) => {
      if (request.tests.includes(ctrl.root)) {
        for (const converter of this.converters.values()) {
          converter.run(ctrl.createTestRun(request), [converter.root], request.debug, token);
        }
        return;
      }

      const involved = new Map<TestConverter, vscode.TestItem<ITestMetadata>[]>();
      for (const test of request.tests) {
        const i = involved.get(test.data.converter);
        if (i) {
          i.push(test);
        } else {
          involved.set(test.data.converter, [test]);
        }
      }

      for (const [converter, tests] of involved) {
        converter.run(ctrl.createTestRun(request), tests, request.debug, token);
      }
    };

    return ctrl;
  }
}

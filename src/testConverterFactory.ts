/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as AdapterTestController } from 'vscode-test-adapter-api';
import { metadata, TestConverter } from './testConverter';

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

  public refresh(test?: vscode.TestItem) {
    for (const converter of this.converters.values()) {
      if (!test || converter.root.id === test.id) {
        converter.refresh();
      }
    }
  }

  private makeTestController() {
    const ctrl = vscode.test.createTestController(
      'ms-vscode.test-adapter-converter',
      'Test Adapter Converter',
    );
    ctrl.root.label = 'Test Adapter Converter';

    const makeRunHandler = (debug: boolean): vscode.TestRunHandler => (request, token) => {
      if (request.tests.includes(ctrl.root)) {
        for (const converter of this.converters.values()) {
          converter.run(ctrl.createTestRun(request), [converter.root], debug, token);
        }
        return;
      }

      const involved = new Map<TestConverter, vscode.TestItem[]>();
      for (const test of request.tests) {
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
    
    ctrl.createRunConfiguration('Run', vscode.TestRunConfigurationGroup.Run, makeRunHandler(false), true);
    ctrl.createRunConfiguration('Debug', vscode.TestRunConfigurationGroup.Debug, makeRunHandler(true), true);

    return ctrl;
  }
}

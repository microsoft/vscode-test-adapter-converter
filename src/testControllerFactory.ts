/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as AdapterTestController } from 'vscode-test-adapter-api';
import { TestController } from './testContoller';

export class TestControllerFactory implements AdapterTestController, vscode.Disposable {
  private readonly disposables = new Map<TestAdapter, vscode.Disposable>();

  /**
   * @inheritdoc
   */
  registerTestAdapter(adapter: TestAdapter): void {
    this.disposables.set(adapter, vscode.test.registerTestController(new TestController(adapter)));
  }

  /**
   * @inheritdoc
   */
  unregisterTestAdapter(adapter: TestAdapter): void {
    this.disposables.get(adapter)?.dispose();
    this.disposables.delete(adapter);
  }

  dispose() {
    for (const disposables of this.disposables.values()) {
      disposables.dispose();
    }
  }
}

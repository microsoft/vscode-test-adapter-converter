/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as AdapterTestController } from 'vscode-test-adapter-api';
import { TestConverter } from './testConverter';

export class TestConverterFactory implements AdapterTestController, vscode.Disposable {
  private readonly converters = new Map<TestAdapter, TestConverter>();

  /**
   * @inheritdoc
   */
  public registerTestAdapter(adapter: TestAdapter): void {
    this.converters.set(adapter, new TestConverter(adapter));
  }

  /**
   * @inheritdoc
   */
  public unregisterTestAdapter(adapter: TestAdapter): void {
    this.converters.get(adapter)?.dispose();
    this.converters.delete(adapter);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const disposables of this.converters.values()) {
      disposables.dispose();
    }

    vscode.commands.executeCommand('setContext', 'hasTestConverterTests', false);
  }

  public refresh() {
    for (const converter of this.converters.values()) {
      converter.refresh();
    }
  }
}

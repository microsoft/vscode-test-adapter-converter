/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { testExplorerExtensionId, TestHub } from 'vscode-test-adapter-api';
import { TestControllerFactory } from './testControllerFactory';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
  if (!testExplorerExtension) {
    return;
  }

  const testHub = testExplorerExtension.exports;
  const factory = new TestControllerFactory();
  context.subscriptions.push(factory);

  testHub.registerTestController(factory);
  context.subscriptions.push({
    dispose() {
      testHub.unregisterTestController(factory);
    },
  });
}

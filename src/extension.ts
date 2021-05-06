/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { testExplorerExtensionId, TestHub } from 'vscode-test-adapter-api';
import { TestControllerFactory } from './testControllerFactory';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('testExplorerConverter.activate', () => {
      const testExplorerExtension = vscode.extensions.getExtension<TestHub>(
        testExplorerExtensionId
      );
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
    })
  );
}

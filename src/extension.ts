/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { testExplorerExtensionId, TestHub } from 'vscode-test-adapter-api';
import { TestConverterFactory } from './testConverterFactory';

const configKey = 'testExplorer.useNativeTesting';

export function activate(context: vscode.ExtensionContext) {
  let factory: TestConverterFactory | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('testExplorerConverter.activate', () => {
      const testExplorerExtension = vscode.extensions.getExtension<TestHub>(
        testExplorerExtensionId
      );
      if (!testExplorerExtension) {
        return;
      }

      const testHub = testExplorerExtension.exports;
      factory = new TestConverterFactory();
      context.subscriptions.push(factory);

      testHub.registerTestController(factory);
      context.subscriptions.push({
        dispose() {
          testHub.unregisterTestController(factory!);
        },
      });
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(configKey)) {
        return;
      }

      if (vscode.workspace.getConfiguration().get(configKey, false) === false) {
        factory?.dispose();
        factory = undefined;
      }
    }),

    vscode.commands.registerCommand('testExplorerConverter.refreshAdapter', () =>
      factory?.refresh()
    ),

    vscode.commands.registerCommand('testExplorerConverter.useNativeTesting', () => {
      const config = vscode.workspace.getConfiguration();
      config.update(configKey, true, vscode.ConfigurationTarget.Global);
    })
  );
}

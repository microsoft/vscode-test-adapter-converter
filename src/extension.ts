/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { testExplorerExtensionId, TestHub } from 'vscode-test-adapter-api';
import {
  OptInController,
  switchToNativeTesting,
  useNativeTestingConfig,
  usingNativeTesting,
} from './optIn';
import { TestConverterFactory } from './testConverterFactory';

export function activate(context: vscode.ExtensionContext) {
  let factory: TestConverterFactory | undefined;

  const optIn = new OptInController(context);
  if (optIn.shouldPrompt()) {
    setTimeout(() => {
      const testHub = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId)?.exports;

      if (!testHub) {
        return;
      }

      testHub.registerTestController(optIn);
      context.subscriptions.push({
        dispose() {
          testHub.unregisterTestController(optIn);
        },
      });
    }, 2000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('testExplorerConverter.activate', () => {
      const testHub = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId)?.exports;
      if (!testHub) {
        return;
      }

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
      if (!e.affectsConfiguration(useNativeTestingConfig)) {
        return;
      }

      if (!usingNativeTesting()) {
        factory?.dispose();
        factory = undefined;
      }
    }),

    vscode.commands.registerCommand('testExplorerConverter.useNativeTesting', () =>
      switchToNativeTesting()
    ),

    vscode.commands.registerCommand('testExplorerConverter.showError', controllerId => {
      const error = factory?.getByControllerId(controllerId)?.error;
      if (error) {
        openUntitledEditor(error);
      }
    })
  );
}

const openUntitledEditor = async (contents: string) => {
  const untitledDoc = await vscode.workspace.openTextDocument({ content: contents });
  await vscode.window.showTextDocument(untitledDoc);
};

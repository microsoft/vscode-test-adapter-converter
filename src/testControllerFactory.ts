/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as AdapterTestController } from 'vscode-test-adapter-api';
import { TestController } from './testContoller';

const settings = [
  'testExplorer.gutterDecoration',
  'testExplorer.codeLens',
  'testExplorer.errorDecoration',
  'testExplorer.errorDecorationHover',
];

export class TestControllerFactory implements AdapterTestController, vscode.Disposable {
  private shouldPromptForUiDisable = vscode.workspace.getConfiguration().get(settings[0]) !== false;
  private readonly disposables = new Map<TestAdapter, vscode.Disposable>();

  /**
   * @inheritdoc
   */
  registerTestAdapter(adapter: TestAdapter): void {
    this.promptDisableExplorerUi();
    this.disposables.set(adapter, vscode.test.registerTestController(new TestController(adapter)));
  }

  /**
   * @inheritdoc
   */
  unregisterTestAdapter(adapter: TestAdapter): void {
    this.disposables.get(adapter)?.dispose();
    this.disposables.delete(adapter);
  }

  /**
   * @inheritdoc
   */
  dispose() {
    for (const disposables of this.disposables.values()) {
      disposables.dispose();
    }
  }

  private async promptDisableExplorerUi() {
    if (!this.shouldPromptForUiDisable) {
      return;
    }

    this.shouldPromptForUiDisable = false;
    const yes = 'Yes';
    const workspace = 'Only in this Workspace';
    const no = 'No';

    const result = await vscode.window.showInformationMessage(
      'Thanks for trying out native VS Code testing! Would you like to disable the default Test Explorer extension UI?',
      no,
      yes,
      workspace
    );

    if (result === yes || result === workspace) {
      const target =
        result === yes ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
      const config = vscode.workspace.getConfiguration();
      for (const setting of settings) {
        config.update(setting, false, target);
      }
    }
  }
}

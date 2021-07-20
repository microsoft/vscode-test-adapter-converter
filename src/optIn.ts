/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { TestAdapter, TestController as TestAdapterController } from 'vscode-test-adapter-api';

const promptStorageKey = 'promptedToUseNative';
let promptedThisSession = false;
export const useNativeTestingConfig = 'testExplorer.useNativeTesting';

export const usingNativeTesting = () =>
  !!vscode.workspace.getConfiguration().get(useNativeTestingConfig, false);

export const switchToNativeTesting = (target = vscode.ConfigurationTarget.Global) => {
  const config = vscode.workspace.getConfiguration();
  config.update(useNativeTestingConfig, true, target);
  vscode.window.showInformationMessage(
    'Thanks for taking native testing for a spin! If you run into problems, you can turn the new experience off with the "testExplorer.useNativeTesting" setting.'
  );
};

export const shouldPromptForNativeTesting = () => !usingNativeTesting();

export class OptInController implements TestAdapterController {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** @inheritdoc */
  public registerTestAdapter(adapter: TestAdapter): void {
    if (!this.shouldPrompt()) {
      return;
    }

    adapter.testStates(evt => {
      if (evt.type === 'started') {
        this.promptToUseNativeTesting();
      }
    });
  }

  /** @inheritdoc */
  public unregisterTestAdapter(): void {
    // no-op
  }

  public shouldPrompt() {
    return (
      !promptedThisSession &&
      !usingNativeTesting() &&
      !this.context.globalState.get(promptStorageKey)
    );
  }

  private async promptToUseNativeTesting() {
    if (!this.shouldPrompt()) {
      return;
    }

    const yes = 'Yes';
    const workspace = 'Only in this Workspace';
    const no = 'No';

    promptedThisSession = true;
    const result = await vscode.window.showInformationMessage(
      "Would you like to try out VS Code's new native UI for testing?",
      no,
      yes,
      workspace
    );

    if (!result) {
      return;
    }

    if (result === yes) {
      switchToNativeTesting(vscode.ConfigurationTarget.Global);
    } else if (result === workspace) {
      switchToNativeTesting(vscode.ConfigurationTarget.Workspace);
    } else if (result === no) {
      this.context.globalState.update(promptStorageKey, true);
    }
  }
}

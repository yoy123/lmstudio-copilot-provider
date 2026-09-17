import * as vscode from 'vscode';
import { LMStudioProvider } from './lmstudio-provider';
import { LMStudioClient } from './lmstudio-client';
import { Logger } from './logger';
import { registerAllTools } from './tools/index';

let provider: LMStudioProvider | undefined;
let registration: vscode.Disposable | undefined;
let outputChannel: vscode.OutputChannel;
let lmStudioTerminal: vscode.Terminal | undefined;
let client: LMStudioClient;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

function hasExplicitSetting(inspection: SettingInspection | undefined): boolean {
  if (!inspection) {
    return false;
  }

  return inspection.globalValue !== undefined
    || inspection.workspaceValue !== undefined
    || inspection.workspaceFolderValue !== undefined;
}

async function applyByokUtilityModelAutoFix(logger: Logger): Promise<void> {
  const extensionConfig = vscode.workspace.getConfiguration('lmstudio-copilot');
  const enabled = extensionConfig.get<boolean>('autoFixByokUtilityModel', true);

  if (!enabled) {
    logger.info('BYOK utility model auto-fix disabled by user setting.');
    return;
  }

  const config = vscode.workspace.getConfiguration();
  const byokDefaultInspection = config.inspect<string>('chat.byokUtilityModelDefault');
  const utilityModelInspection = config.inspect<string>('chat.utilityModel');
  const utilitySmallModelInspection = config.inspect<string>('chat.utilitySmallModel');

  // Respect explicit user/workspace choices. Only patch when all three are untouched.
  if (hasExplicitSetting(byokDefaultInspection)
    || hasExplicitSetting(utilityModelInspection)
    || hasExplicitSetting(utilitySmallModelInspection)) {
    logger.info('Skipping BYOK utility model auto-fix because chat utility settings are already explicitly configured.');
    return;
  }

  await config.update('chat.byokUtilityModelDefault', 'mainAgent', vscode.ConfigurationTarget.Global);
  await config.update('chat.utilityModel', '', vscode.ConfigurationTarget.Global);
  await config.update('chat.utilitySmallModel', '', vscode.ConfigurationTarget.Global);

  logger.info('Applied BYOK utility model auto-fix: chat.byokUtilityModelDefault=mainAgent, chat.utilityModel="", chat.utilitySmallModel="".');
}

export async function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('LM Studio Provider');
  context.subscriptions.push(outputChannel);

  const logger = new Logger(outputChannel);
  const isRemoteExtensionHost = Boolean(vscode.env.remoteName);

  logger.info(`LM Studio Copilot Provider is activating... v${context.extension.packageJSON.version}`);
  if (isRemoteExtensionHost) {
    logger.info(`Remote extension host detected (${vscode.env.remoteName}); skipping BYOK utility model auto-fix.`);
  } else {
    void applyByokUtilityModelAutoFix(logger).catch((error) => {
      logger.warn(`BYOK utility model auto-fix skipped due to error: ${error}`);
    });
  }

  const registerProvider = (): void => {
    registration?.dispose();
    provider?.dispose();

    client = new LMStudioClient(logger);
    provider = new LMStudioProvider(client, context, logger);

    registration = vscode.lm.registerLanguageModelChatProvider('lmstudio', provider);
    logger.info('✅ Provider registered successfully with vendor: lmstudio');
  };

  registerProvider();

  const getOrCreateTerminalByName = (terminalName: string): vscode.Terminal => {
    const existing = vscode.window.terminals.find((t) => t.name === terminalName);
    if (existing) {
      return existing;
    }
    return vscode.window.createTerminal({ name: terminalName });
  };

  const getOrCreateServerTerminal = (): vscode.Terminal => {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const terminalName = config.get<string>('terminalName', 'LM Studio Server');

    lmStudioTerminal = getOrCreateTerminalByName(terminalName);
    return lmStudioTerminal;
  };

  const startServerInTerminal = async (silent = false): Promise<boolean> => {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const launchCommand = config.get<string>('launchCommand', '').trim();

    if (!launchCommand) {
      const message = 'LM Studio CLI auto-start is unavailable and no fallback launch command is configured.';
      logger.warn(`⚠️ ${message}`);
      logger.warn('   If LM Studio is already running, you can ignore this message.');
      if (!silent) {
        vscode.window.showWarningMessage(message);
      }
      return false;
    }

    const terminal = getOrCreateServerTerminal();
    terminal.show(true);
    logger.info(`Starting LM Studio server in terminal with command: ${launchCommand}`);
    terminal.sendText(launchCommand, true);

    const startupWaitMs = config.get<number>('startupWaitMs', 3000);
    await sleep(Math.max(startupWaitMs, 0));

    const connected = await client.checkConnection();
    if (connected) {
      logger.info('✅ LM Studio server appears reachable after terminal launch');
      return true;
    }

    logger.warn('⚠️ LM Studio server not reachable yet after terminal launch');
    return false;
  };

  const ensureServerRunning = async (silent = false): Promise<boolean> => {
    logger.info('Ensuring LM Studio server is running...');

    if (!client.isLocalServerUrl()) {
      logger.info('Remote server configured; skipping local CLI auto-start and terminal fallback');
      return await client.checkConnection();
    }

    const startedViaCli = await client.ensureServerRunning();
    if (startedViaCli) {
      logger.info('✅ LM Studio server is reachable');
      return true;
    }

    logger.info('CLI-based auto-start unavailable, trying launchCommand fallback');
    return startServerInTerminal(silent);
  };

  const stopServerTerminal = (): void => {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const terminalName = config.get<string>('terminalName', 'LM Studio Server');
    const terminal = lmStudioTerminal ?? vscode.window.terminals.find((t) => t.name === terminalName);

    if (!terminal) {
      vscode.window.showInformationMessage('LM Studio terminal is not running.');
      return;
    }

    logger.info(`Stopping LM Studio terminal: ${terminal.name}`);
    terminal.dispose();
    lmStudioTerminal = undefined;
    vscode.window.showInformationMessage('LM Studio terminal stopped.');
  };

  // Register all LM tools (terminal, read_file, write_file, list_directory, search_files)
  registerAllTools(context, logger);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio-copilot.startServer', async () => {
      if (!client.isLocalServerUrl()) {
        vscode.window.showWarningMessage('Configured LM Studio server is remote; start it on the remote host instead of using the local CLI.');
        return;
      }

      const started = await ensureServerRunning();
      if (started) {
        vscode.window.showInformationMessage('LM Studio server is running');
        await provider?.refreshModels();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio-copilot.stopServer', async () => {
      if (!client.isLocalServerUrl()) {
        vscode.window.showWarningMessage('Configured LM Studio server is remote; stop it on the remote host instead of using the local CLI.');
        return;
      }

      const stopped = await client.stopServer();
      if (stopped) {
        lmStudioTerminal?.dispose();
        lmStudioTerminal = undefined;
        vscode.window.showInformationMessage('LM Studio server stopped.');
        return;
      }

      stopServerTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio-copilot.refreshModels', async () => {
      logger.info('Refreshing models...');
      await provider?.refreshModels();
      vscode.window.showInformationMessage('LM Studio models refreshed');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio-copilot.checkConnection', async () => {
      const connected = await client.checkConnection();
      if (connected) {
        vscode.window.showInformationMessage('✅ Connected to LM Studio server');
        logger.info('✅ Connection check: OK');
      } else {
        vscode.window.showErrorMessage('❌ Cannot connect to LM Studio server. Make sure it is running.');
        logger.error('❌ Connection check: FAILED');
      }
    })
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('lmstudio-copilot')) {
        if (e.affectsConfiguration('lmstudio-copilot.apiKey')) {
          logger.info('API key changed, re-registering provider to refresh authenticated requests');
          registerProvider();
        }
        logger.info('Configuration changed, refreshing models...');
        provider?.refreshModels();
      }
    })
  );

  // Auto-start / refresh run in background so extension activation stays fast.
  const config = vscode.workspace.getConfiguration('lmstudio-copilot');
  const allowStartupTasksOnRemote = config.get<boolean>('allowStartupTasksOnRemote', false);

  void (async () => {
    if (isRemoteExtensionHost && !allowStartupTasksOnRemote) {
      logger.info('Skipping auto-start and auto-refresh on remote extension host. Set lmstudio-copilot.allowStartupTasksOnRemote=true to re-enable.');
      return;
    }

    if (config.get<boolean>('autoStartServer', true)) {
      logger.info('Auto-start server enabled, ensuring LM Studio is running...');
      await ensureServerRunning(true);
    }

    if (config.get<boolean>('autoRefreshModels', true)) {
      logger.info('Auto-refresh enabled, refreshing models now...');
      await provider?.refreshModels();
    }
  })().catch((error) => {
    logger.warn(`Startup background tasks failed: ${error}`);
  });

  logger.info(`LM Studio Copilot Provider activated v${context.extension.packageJSON.version}`);
}

export function deactivate() {
  registration?.dispose();
  registration = undefined;
  lmStudioTerminal?.dispose();
  lmStudioTerminal = undefined;
  provider?.dispose();
  provider = undefined;
}

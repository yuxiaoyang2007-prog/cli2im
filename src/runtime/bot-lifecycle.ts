export type BotRuntimeState = 'disabled' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type BotStopMode = 'drain' | 'cancel';

export interface BotLifecycleHooks {
  start(): Promise<void>;
  /** Stop accepting messages immediately. Drain or cancel owned tasks, then disconnect. */
  stop(options: { mode: BotStopMode }): Promise<void>;
}

interface BotRuntime {
  hooks: BotLifecycleHooks;
  state: BotRuntimeState;
  enabled: boolean;
  error?: 'start_failed' | 'stop_failed';
  operations: Promise<void>;
}

export interface BotRuntimeStatus {
  name: string;
  state: BotRuntimeState;
  enabled: boolean;
  acceptsMessages: boolean;
  error?: 'start_failed' | 'stop_failed';
}

/** Serializes one bot's lifecycle without blocking or restarting its neighbours. */
export class BotLifecycle {
  private bots = new Map<string, BotRuntime>();

  register(name: string, hooks: BotLifecycleHooks, options: { enabled?: boolean } = {}): void {
    if (this.bots.has(name)) throw new Error(`Bot already registered: ${name}`);
    const enabled = options.enabled !== false;
    this.bots.set(name, { hooks, enabled, state: enabled ? 'stopped' : 'disabled', operations: Promise.resolve() });
  }

  status(name: string): BotRuntimeStatus {
    const bot = this.get(name);
    return { name, state: bot.state, enabled: bot.enabled, acceptsMessages: bot.enabled && bot.state === 'running', error: bot.error };
  }

  list(): BotRuntimeStatus[] {
    return [...this.bots.keys()].map((name) => this.status(name));
  }

  start(name: string): Promise<void> {
    return this.serialize(name, async (bot) => {
      if (!bot.enabled || bot.state === 'running') return;
      await this.startBot(bot);
    });
  }

  stop(name: string, mode: BotStopMode = 'drain'): Promise<void> {
    return this.serialize(name, (bot) => this.stopBot(bot, mode));
  }

  restart(name: string, mode: BotStopMode = 'drain'): Promise<void> {
    return this.serialize(name, async (bot) => {
      await this.stopBot(bot, mode);
      if (bot.enabled) await this.startBot(bot);
    });
  }

  setEnabled(name: string, enabled: boolean, mode: BotStopMode = 'drain'): Promise<void> {
    return this.serialize(name, async (bot) => {
      bot.enabled = enabled;
      if (enabled) await this.startBot(bot);
      else await this.stopBot(bot, mode);
    });
  }

  async startAll(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.bots.keys()].map((name) => this.start(name)));
  }

  async stopAll(mode: BotStopMode = 'drain'): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.bots.keys()].map((name) => this.stop(name, mode)));
  }

  private get(name: string): BotRuntime {
    const bot = this.bots.get(name);
    if (!bot) throw new Error(`Unknown bot: ${name}`);
    return bot;
  }

  private serialize(name: string, operation: (bot: BotRuntime) => Promise<void>): Promise<void> {
    const bot = this.get(name);
    const next = bot.operations.catch(() => {}).then(() => operation(bot));
    bot.operations = next.catch(() => {});
    return next;
  }

  private async startBot(bot: BotRuntime): Promise<void> {
    if (bot.state === 'running') return;
    bot.state = 'starting';
    bot.error = undefined;
    try {
      await bot.hooks.start();
      bot.state = 'running';
    } catch (error) {
      // A partial connect can leave listeners or owned children behind.
      await bot.hooks.stop({ mode: 'cancel' }).catch(() => {});
      bot.state = 'failed';
      bot.error = 'start_failed';
      throw error;
    }
  }

  private async stopBot(bot: BotRuntime, mode: BotStopMode): Promise<void> {
    if (bot.state === 'stopped' || bot.state === 'disabled') {
      bot.state = bot.enabled ? 'stopped' : 'disabled';
      return;
    }
    bot.state = 'stopping';
    bot.error = undefined;
    try {
      await bot.hooks.stop({ mode });
      bot.state = bot.enabled ? 'stopped' : 'disabled';
    } catch (error) {
      bot.state = 'failed';
      bot.error = 'stop_failed';
      throw error;
    }
  }
}

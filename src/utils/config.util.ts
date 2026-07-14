import dotenv from 'dotenv';
import path from 'path';
import { Logger } from './logger.util.js';
import fs from 'fs';
import os from 'os';

// Create a contextualized logger for this file
const configLogger = Logger.forContext('utils/config.util.ts');

// Log config utility initialization
configLogger.debug('Config utility initialized');

/**
 * Configuration loader that handles multiple sources with priority:
 * 1. Direct ENV pass (process.env)
 * 2. .env file in project root
 * 3. Global config file at $HOME/.mcp/configs.json
 */
class ConfigLoader {
	private packageName: string;
	private configLoaded: boolean = false;

	/**
	 * Create a new ConfigLoader instance
	 * @param packageName The package name to use for global config lookup
	 */
	constructor(packageName: string) {
		this.packageName = packageName;
	}

	/**
	 * Load configuration from all sources with proper priority
	 */
	load(): void {
		if (this.configLoaded) {
			configLogger.debug(
				'[src/utils/config.util.ts@load] Configuration already loaded, skipping',
			);
			return;
		}

		configLogger.debug(
			'[src/utils/config.util.ts@load] Loading configuration...',
		);

		// Priority 3: Load from global config file
		this.loadFromGlobalConfig();

		// Priority 2: Load from .env file
		this.loadFromEnvFile();

		// Priority 1: Direct ENV pass is already in process.env
		// No need to do anything as it already has highest priority

		this.configLoaded = true;
		configLogger.debug(
			'[src/utils/config.util.ts@load] Configuration loaded successfully',
		);
	}

	/**
	 * Load configuration from .env file in project root
	 */
	private loadFromEnvFile(): void {
		const methodLogger = Logger.forContext(
			'utils/config.util.ts',
			'loadFromEnvFile',
		);

		// Toggle: USE_DOTENV=false disables .env reading entirely (credentials
		// then come only from real env vars / the global config file). Anything
		// else (unset / "true") reads it. Exposed as a UI switch in the MCPB
		// manifest so a user can opt out without editing config.
		if (String(process.env.USE_DOTENV).toLowerCase() === 'false') {
			methodLogger.debug('USE_DOTENV=false — skipping .env file');
			return;
		}

		// Resolve the .env path. DOTENV_CONFIG_PATH pins an explicit file —
		// process.cwd() of a spawned MCP server is not guaranteed to be this
		// package's dir, so we don't rely on dotenv's cwd-relative default.
		// Expand a leading ~ ourselves: neither Claude Code's ${VAR} substitution
		// nor Node's fs resolve it, so "~/.claude/jira.env" would otherwise be
		// taken literally. Fall back to <cwd>/.env when nothing is pinned.
		let envPath = process.env.DOTENV_CONFIG_PATH;
		if (envPath && /^~(?=$|[\\/])/.test(envPath)) {
			envPath = path.join(os.homedir(), envPath.slice(1));
		}
		if (!envPath) {
			envPath = path.resolve('.env');
		}

		try {
			if (!fs.existsSync(envPath)) {
				methodLogger.debug(`No .env file at ${envPath}`);
				return;
			}
			// Parse only — do NOT let dotenv write to process.env directly.
			// We set a key only when it is absent or empty, so an empty
			// ATLASSIAN_* handed in by a launcher (e.g. an unfilled Claude
			// Desktop config field) does not shadow the value from the .env
			// file. This is what lets the server read ~/.claude/jira.env when
			// found instead of forcing the user to fill the UI fields.
			const parsed = dotenv.parse(fs.readFileSync(envPath));
			let applied = 0;
			for (const [key, value] of Object.entries(parsed)) {
				if (
					process.env[key] === undefined ||
					process.env[key] === ''
				) {
					process.env[key] = value;
					applied++;
				}
			}
			methodLogger.debug(`Loaded ${applied} value(s) from ${envPath}`);
		} catch (error) {
			methodLogger.error('Error loading .env file', error);
		}
	}

	/**
	 * Load configuration from global config file at $HOME/.mcp/configs.json
	 */
	private loadFromGlobalConfig(): void {
		const methodLogger = Logger.forContext(
			'utils/config.util.ts',
			'loadFromGlobalConfig',
		);

		try {
			const homedir = os.homedir();
			const globalConfigPath = path.join(homedir, '.mcp', 'configs.json');

			if (!fs.existsSync(globalConfigPath)) {
				methodLogger.debug(
					'[src/utils/config.util.ts@loadFromGlobalConfig] Global config file not found',
				);
				return;
			}

			const configContent = fs.readFileSync(globalConfigPath, 'utf8');
			const config = JSON.parse(configContent);

			// Determine the potential keys for the current package
			const shortKey = 'jira'; // Project-specific short key
			const atlassianProductKey = 'atlassian-jira'; // New supported key
			const fullPackageName = this.packageName; // e.g., '@aashari/mcp-server-atlassian-jira'
			const unscopedPackageName =
				fullPackageName.split('/')[1] || fullPackageName; // e.g., 'mcp-server-atlassian-jira'

			// Define the prioritized order of keys to check
			const potentialKeys = [
				shortKey,
				atlassianProductKey,
				fullPackageName,
				unscopedPackageName,
			];
			let foundConfigSection: {
				environments?: Record<string, unknown>;
			} | null = null;
			let usedKey: string | null = null;

			for (const key of potentialKeys) {
				if (
					config[key] &&
					typeof config[key] === 'object' &&
					config[key].environments
				) {
					foundConfigSection = config[key];
					usedKey = key;
					methodLogger.debug(
						`[src/utils/config.util.ts@loadFromGlobalConfig] Found configuration using key: ${key}`,
					);
					break; // Stop once found
				}
			}

			if (!foundConfigSection || !foundConfigSection.environments) {
				methodLogger.debug(
					`[src/utils/config.util.ts@loadFromGlobalConfig] No configuration found for ${
						this.packageName
					} using keys: ${potentialKeys.join(', ')}`,
				);
				return;
			}

			const environments = foundConfigSection.environments;
			for (const [key, value] of Object.entries(environments)) {
				// Only set if not already defined in process.env
				if (process.env[key] === undefined) {
					process.env[key] = String(value);
				}
			}

			methodLogger.debug(
				`[src/utils/config.util.ts@loadFromGlobalConfig] Loaded configuration from global config file using key: ${usedKey}`,
			);
		} catch (error) {
			methodLogger.error(
				'[src/utils/config.util.ts@loadFromGlobalConfig] Error loading global config file',
				error,
			);
		}
	}

	/**
	 * Get a configuration value
	 * @param key The configuration key
	 * @param defaultValue The default value if the key is not found
	 * @returns The configuration value or the default value
	 */
	get(key: string, defaultValue?: string): string | undefined {
		return process.env[key] || defaultValue;
	}

	/**
	 * Get a boolean configuration value
	 * @param key The configuration key
	 * @param defaultValue The default value if the key is not found
	 * @returns The boolean configuration value or the default value
	 */
	getBoolean(key: string, defaultValue: boolean = false): boolean {
		const value = this.get(key);
		if (value === undefined) {
			return defaultValue;
		}
		return value.toLowerCase() === 'true';
	}
}

// Create and export a singleton instance with the package name from package.json
export const config = new ConfigLoader('@aashari/mcp-server-atlassian-jira');

import { PGLiteDatabaseAdapter } from "@elizaos/adapter-pglite";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { RedisClient } from "@elizaos/adapter-redis";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { SupabaseDatabaseAdapter } from "@elizaos/adapter-supabase";
import { AutoClientInterface } from "@elizaos/client-auto";
import { DiscordClientInterface } from "@elizaos/client-discord";
import { TelegramClientInterface } from "@elizaos/client-telegram";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import { DirectClient } from "@elizaos/client-direct";
import { PrimusAdapter } from "@elizaos/plugin-primus";
import {
    AgentRuntime,
    CacheManager,
    CacheStore,
    Character,
    Client,
    Clients,
    DbCacheAdapter,
    elizaLogger,
    FsCacheAdapter,
    IAgentRuntime,
    ICacheManager,
    IDatabaseAdapter,
    IDatabaseCacheAdapter,
    ModelProviderName,
    settings,
    stringToUuid,
    validateCharacterConfig,
} from "@elizaos/core";
import { zgPlugin } from "@elizaos/plugin-0g";

import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import createGoatPlugin from "@elizaos/plugin-goat";
import { abstractPlugin } from "@elizaos/plugin-abstract";
import {
    advancedTradePlugin,
    coinbaseCommercePlugin,
    coinbaseMassPaymentsPlugin,
    tokenContractPlugin,
    tradePlugin,
    webhookPlugin,
} from "@elizaos/plugin-coinbase";
import { coinmarketcapPlugin } from "@elizaos/plugin-coinmarketcap";
import { evmPlugin } from "@elizaos/plugin-evm";
import { imageGenerationPlugin } from "@elizaos/plugin-image-generation";
import { nearPlugin } from "@elizaos/plugin-near";
import { nftGenerationPlugin } from "@elizaos/plugin-nft-generation";
import { createNodePlugin } from "@elizaos/plugin-node";
import { sgxPlugin } from "@elizaos/plugin-sgx";
import { solanaPlugin } from "@elizaos/plugin-solana";
import { solanaAgentkitPlguin } from "@elizaos/plugin-solana-agentkit";
import { autonomePlugin } from "@elizaos/plugin-autonome";
import { TEEMode, teePlugin } from "@elizaos/plugin-tee";
import { teeLogPlugin } from "@elizaos/plugin-tee-log";
import { hyperliquidPlugin } from "@elizaos/plugin-hyperliquid";
import { OpacityAdapter } from "@elizaos/plugin-opacity";
import Database from "better-sqlite3";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import amqp, { ConsumeMessage } from "amqplib";
import { config } from "./config";
import { promises as fsn } from "fs";
import {
    Agent,
    AgentCredentials,
    decodeMessage,
    decodeMessageCredentials,
    decrypt,
} from "./utils";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

const logFetch = async (url: string, options: any) => {
    elizaLogger.debug(`Fetching ${url}`);
    // Disabled to avoid disclosure of sensitive information such as API keys
    // elizaLogger.debug(JSON.stringify(options, null, 2));
    return fetch(url, options);
};

function connectToRabbitMQ() {
    return amqp
        .connect({
            hostname: config.rabbitmq.host,
            port: 5672,
            username: config.rabbitmq.username,
            password: config.rabbitmq.password,
            vhost: "/",
        })
        .then((connection) => {
            elizaLogger.log("Successfully connected to RabbitMQ");
            return connection;
        })
        .catch((error) => {
            console.log("Failed to connect to RabbitMQ:", error);
            elizaLogger.error("Failed to connect to RabbitMQ:", error);
            throw new Error(`RabbitMQ connection error: ${error.message}`);
        });
}

async function createChannel(connection) {
    try {
        const channel = await connection.createChannel();
        elizaLogger.log("Successfully created RabbitMQ channel");
        return channel;
    } catch (error) {
        elizaLogger.error("Failed to create RabbitMQ channel:", error);
        throw new Error(`Channel creation error: ${error.message}`);
    }
}

async function assertQueues(channel) {
    try {
        await channel.assertQueue(config.rabbitmq.QUEUE_AGENT_CREATION, {
            durable: true,
        });
        await channel.assertQueue(config.rabbitmq.QUEUE_AGENT_CREDENTIALS, {
            durable: true,
        });
        elizaLogger.log("Successfully asserted RabbitMQ queues");
    } catch (error) {
        elizaLogger.error("Failed to assert RabbitMQ queues:", error);
        throw new Error(`Queue assertion error: ${error.message}`);
    }
}

async function setupConsumers(channel, directClient) {
    try {
        channel.consume(config.rabbitmq.QUEUE_AGENT_CREATION, async (msg) => {
            if (msg) {
                try {
                    const agents = decodeMessage(msg);
                    await handleAgentCreation(agents, directClient);
                    channel.ack(msg);
                    elizaLogger.info(
                        "Agent creation message processed",
                        JSON.stringify(agents)
                    );
                } catch (error) {
                    elizaLogger.error(
                        "Error processing agent_creation message:",
                        error
                    );
                    channel.nack(msg);
                }
            }
        });

        channel.consume(
            config.rabbitmq.QUEUE_AGENT_CREDENTIALS,
            async (msg) => {
                if (msg) {
                    try {
                        const credentials = decodeMessageCredentials(msg);
                        await handleAgentCredentials(credentials, directClient);
                        channel.ack(msg);
                        elizaLogger.info("Agent credentials processed", {
                            address: credentials.address,
                            email: credentials.email,
                        });
                    } catch (error) {
                        elizaLogger.error(
                            "Error processing agent_credentials message:",
                            error
                        );
                        channel.nack(msg);
                    }
                }
            }
        );

        elizaLogger.log("Successfully set up RabbitMQ consumers");
    } catch (error) {
        elizaLogger.error("Failed to set up RabbitMQ consumers:", error);
        throw new Error(`Consumer setup error: ${error.message}`);
    }
}

async function setupRabbitMQ(directClient: DirectClient) {
    try {
        const connection = await connectToRabbitMQ();
        const channel = await createChannel(connection);
        await assertQueues(channel);
        await setupConsumers(channel, directClient);
        elizaLogger.log("RabbitMQ setup completed successfully");
    } catch (error) {
        elizaLogger.error("RabbitMQ setup failed:", error);
    }
}

async function handleAgentCreation(
    agents: Agent[],
    directClient: DirectClient
) {
    for (const agentData of agents) {
        try {
            const character = await createCharacter(agentData);
            await saveCharacterFile(character);
            await startAgent(character, directClient);
            elizaLogger.log(`Agent created and started: ${character.id}`);
        } catch (error) {
            elizaLogger.error(
                `Error creating agent: ${agentData.address}`,
                error
            );
        }
    }
}

async function handleAgentCredentials(credentials, directClient: DirectClient) {
    const { address, login, password, email } = credentials;
    try {
        const charactersDir = path.join(__dirname, "../../characters");
        const characterPath = path.join(charactersDir, `${address}.json`);

        // Update the character with new credentials
        await updateCharacterWithCredentials(address, login, password, email);
        // Restart the agent with updated credentials
        const updatedCharacter = await loadCharacter(characterPath);
        await startAgent(updatedCharacter, directClient);

        elizaLogger.log(
            `Credentials updated and agent restarted for: ${address}`
        );
    } catch (error) {
        elizaLogger.error(
            `Error updating credentials for agent: ${address}`,
            error
        );
    }
}

export async function updateCharacterWithCredentials(
    agentAddress: string,
    login: string,
    password: string,
    email: string
): Promise<void> {
    const characterPath = path.join("../characters", `${agentAddress}.json`);

    try {
        const characterData = await fsn.readFile(characterPath, "utf-8");
        const character: Character = JSON.parse(characterData);

        character.settings = character.settings || {};
        character.settings.secrets = character.settings.secrets || {};
        character.settings.secrets.TWITTER_USERNAME = login;
        character.settings.secrets.TWITTER_EMAIL = email;
        character.settings.secrets.TWITTER_PASSWORD_ENCRYPTED = password;
        character.clients = [Clients.TWITTER];

        await fsn.writeFile(characterPath, JSON.stringify(character, null, 2));

        elizaLogger.log(`Credentials updated for agent: ${agentAddress}`);
    } catch (error) {
        elizaLogger.error(
            `Error updating credentials for agent: ${agentAddress}`,
            error
        );
        throw error; // Rethrow the error to be caught in handleAgentCredentials
    }
}

async function createCharacter(agentData: Agent): Promise<Character> {
    return {
        name: agentData.name,
        bio: [agentData.description],
        lore: [],
        settings: { secrets: { id: agentData.address } },
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        clients: [],
        plugins: [],
        style: {
            all: [],
            chat: [],
            post: [],
        },
        modelProvider: ModelProviderName.OPENAI,
    };
}

async function saveCharacterFile(character: Character): Promise<void> {
    const outputDir = "../characters";
    await fsn.mkdir(outputDir, { recursive: true });
    const outputFile = path.join(
        outputDir,
        `${character.settings.secrets.id}.json`
    );
    await fsn.writeFile(outputFile, JSON.stringify(character, null, 2));
}

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(3))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .parseSync();
    } catch (error) {
        elizaLogger.error("Error parsing arguments:", error);
        return {};
    }
}

function tryLoadFile(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        return null;
    }
}

function mergeCharacters(base: Character, child: Character): Character {
    const mergeObjects = (baseObj: any, childObj: any) => {
        const result: any = {};
        const keys = new Set([
            ...Object.keys(baseObj || {}),
            ...Object.keys(childObj || {}),
        ]);
        keys.forEach((key) => {
            if (
                typeof baseObj[key] === "object" &&
                typeof childObj[key] === "object" &&
                !Array.isArray(baseObj[key]) &&
                !Array.isArray(childObj[key])
            ) {
                result[key] = mergeObjects(baseObj[key], childObj[key]);
            } else if (
                Array.isArray(baseObj[key]) ||
                Array.isArray(childObj[key])
            ) {
                result[key] = [
                    ...(baseObj[key] || []),
                    ...(childObj[key] || []),
                ];
            } else {
                result[key] =
                    childObj[key] !== undefined ? childObj[key] : baseObj[key];
            }
        });
        return result;
    };
    return mergeObjects(base, child);
}

async function loadCharacter(filePath: string): Promise<Character> {
    const content = tryLoadFile(filePath);
    if (!content) {
        throw new Error(`Character file not found: ${filePath}`);
    }

    let character = JSON.parse(content);
    validateCharacterConfig(character);

    // .id isn't really valid
    const characterId = stringToUuid(character.settings?.secrets?.id);
    const characterPrefix = `CHARACTER.${characterId.toUpperCase().replace(/ /g, "_")}.`;
    const characterSettings = Object.entries(process.env)
        .filter(([key]) => key.startsWith(characterPrefix))
        .reduce((settings, [key, value]) => {
            const settingKey = key.slice(characterPrefix.length);
            return { ...settings, [settingKey]: value };
        }, {});
    if (Object.keys(characterSettings).length > 0) {
        character.settings = character.settings || {};
        character.settings.secrets = {
            ...characterSettings,
            ...character.settings.secrets,
        };
    }
    // Handle plugins
    character.plugins = await handlePluginImporting(character.plugins);
    if (character.extends) {
        elizaLogger.info(
            `Merging  ${character.name} character with parent characters`
        );
        for (const extendPath of character.extends) {
            const baseCharacter = await loadCharacter(
                path.resolve(path.dirname(filePath), extendPath)
            );
            character = mergeCharacters(baseCharacter, character);
            elizaLogger.info(
                `Merged ${character.name} with ${baseCharacter.name}`
            );
        }
    }
    elizaLogger.log(
        `Successfully loaded character from: ${filePath}, with content: ${character}`
    );
    return character;
}

export async function loadCharacters(
    charactersArg?: string
): Promise<Character[]> {
    let loadedCharacters: Character[] = [];

    if (charactersArg) {
        // Existing logic for loading specific characters
        let characterPaths = charactersArg
            .split(",")
            .map((filePath) => filePath.trim());
        // ... (rest of the existing logic for loading specific characters)
    }

    // If no characters were loaded or no argument was provided, load all existing characters
    if (loadedCharacters.length === 0) {
        const charactersDir = path.join(__dirname, "../../characters");
        const files = await fsn.readdir(charactersDir);
        const characterFiles = files.filter((file) => file.endsWith(".json"));

        for (const file of characterFiles) {
            const characterPath = path.join(charactersDir, file);
            try {
                const character = await loadCharacter(characterPath);
                loadedCharacters.push(character);
                elizaLogger.info(
                    `Successfully loaded character from: ${characterPath}`
                );
            } catch (e) {
                elizaLogger.error(
                    `Error parsing character from ${characterPath}: ${e}`
                );
            }
        }
    }

    if (loadedCharacters.length === 0) {
        elizaLogger.info("No characters found, using default character");
    }

    return loadedCharacters;
}

async function handlePluginImporting(plugins: string[]) {
    if (plugins.length > 0) {
        elizaLogger.info("Plugins are: ", plugins);
        const importedPlugins = await Promise.all(
            plugins.map(async (plugin) => {
                try {
                    const importedPlugin = await import(plugin);
                    const functionName =
                        plugin
                            .replace("@elizaos/plugin-", "")
                            .replace(/-./g, (x) => x[1].toUpperCase()) +
                        "Plugin"; // Assumes plugin function is camelCased with Plugin suffix
                    return (
                        importedPlugin.default || importedPlugin[functionName]
                    );
                } catch (importError) {
                    elizaLogger.error(
                        `Failed to import plugin: ${plugin}`,
                        importError
                    );
                    return []; // Return null for failed imports
                }
            })
        );
        return importedPlugins;
    } else {
        return [];
    }
}

export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
): string | undefined {
    switch (provider) {
        // no key needed for llama_local or gaianet
        case ModelProviderName.LLAMALOCAL:
            return "";
        case ModelProviderName.OLLAMA:
            return "";
        case ModelProviderName.GAIANET:
            return "";
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.ETERNALAI:
            return (
                character.settings?.secrets?.ETERNALAI_API_KEY ||
                settings.ETERNALAI_API_KEY
            );
        case ModelProviderName.NINETEEN_AI:
            return (
                character.settings?.secrets?.NINETEEN_AI_API_KEY ||
                settings.NINETEEN_AI_API_KEY
            );
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
            return (
                character.settings?.secrets?.LLAMACLOUD_API_KEY ||
                settings.LLAMACLOUD_API_KEY ||
                character.settings?.secrets?.TOGETHER_API_KEY ||
                settings.TOGETHER_API_KEY ||
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.CLAUDE_VERTEX:
        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProviderName.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY ||
                settings.REDPILL_API_KEY
            );
        case ModelProviderName.OPENROUTER:
            return (
                character.settings?.secrets?.OPENROUTER ||
                settings.OPENROUTER_API_KEY
            );
        case ModelProviderName.GROK:
            return (
                character.settings?.secrets?.GROK_API_KEY ||
                settings.GROK_API_KEY
            );
        case ModelProviderName.HEURIST:
            return (
                character.settings?.secrets?.HEURIST_API_KEY ||
                settings.HEURIST_API_KEY
            );
        case ModelProviderName.GROQ:
            return (
                character.settings?.secrets?.GROQ_API_KEY ||
                settings.GROQ_API_KEY
            );
        case ModelProviderName.GALADRIEL:
            return (
                character.settings?.secrets?.GALADRIEL_API_KEY ||
                settings.GALADRIEL_API_KEY
            );
        case ModelProviderName.FAL:
            return (
                character.settings?.secrets?.FAL_API_KEY || settings.FAL_API_KEY
            );
        case ModelProviderName.ALI_BAILIAN:
            return (
                character.settings?.secrets?.ALI_BAILIAN_API_KEY ||
                settings.ALI_BAILIAN_API_KEY
            );
        case ModelProviderName.VOLENGINE:
            return (
                character.settings?.secrets?.VOLENGINE_API_KEY ||
                settings.VOLENGINE_API_KEY
            );
        case ModelProviderName.NANOGPT:
            return (
                character.settings?.secrets?.NANOGPT_API_KEY ||
                settings.NANOGPT_API_KEY
            );
        case ModelProviderName.HYPERBOLIC:
            return (
                character.settings?.secrets?.HYPERBOLIC_API_KEY ||
                settings.HYPERBOLIC_API_KEY
            );
        case ModelProviderName.VENICE:
            return (
                character.settings?.secrets?.VENICE_API_KEY ||
                settings.VENICE_API_KEY
            );
        case ModelProviderName.AKASH_CHAT_API:
            return (
                character.settings?.secrets?.AKASH_CHAT_API_KEY ||
                settings.AKASH_CHAT_API_KEY
            );
        case ModelProviderName.GOOGLE:
            return (
                character.settings?.secrets?.GOOGLE_GENERATIVE_AI_API_KEY ||
                settings.GOOGLE_GENERATIVE_AI_API_KEY
            );
        case ModelProviderName.MISTRAL:
            return (
                character.settings?.secrets?.MISTRAL_API_KEY ||
                settings.MISTRAL_API_KEY
            );
        case ModelProviderName.LETZAI:
            return (
                character.settings?.secrets?.LETZAI_API_KEY ||
                settings.LETZAI_API_KEY
            );
        case ModelProviderName.INFERA:
            return (
                character.settings?.secrets?.INFERA_API_KEY ||
                settings.INFERA_API_KEY
            );
        case ModelProviderName.DEEPSEEK:
            return (
                character.settings?.secrets?.DEEPSEEK_API_KEY ||
                settings.DEEPSEEK_API_KEY
            );
        default:
            const errorMessage = `Failed to get token - unsupported model provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
    }
}

function initializeDatabase(dataDir: string) {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        elizaLogger.info("Initializing Supabase connection...");
        const db = new SupabaseDatabaseAdapter(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to Supabase database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to Supabase:", error);
            });

        return db;
    } else if (process.env.POSTGRES_URL) {
        elizaLogger.info("Initializing PostgreSQL connection...");
        const db = new PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
            parseInputs: true,
        });

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to PostgreSQL database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to PostgreSQL:", error);
            });

        return db;
    } else if (process.env.PGLITE_DATA_DIR) {
        elizaLogger.info("Initializing PgLite adapter...");
        // `dataDir: memory://` for in memory pg
        const db = new PGLiteDatabaseAdapter({
            dataDir: process.env.PGLITE_DATA_DIR,
        });
        return db;
    } else {
        const filePath =
            process.env.SQLITE_FILE ?? path.resolve(dataDir, "db.sqlite");
        elizaLogger.info(`Initializing SQLite database at ${filePath}...`);
        const db = new SqliteDatabaseAdapter(new Database(filePath));

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to SQLite database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to SQLite:", error);
            });

        return db;
    }
}

// also adds plugins from character file into the runtime
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    // each client can only register once
    // and if we want two we can explicitly support it
    const clients: Record<string, any> = {};
    const clientTypes: string[] =
        character.clients?.map((str) => str.toLowerCase()) || [];
    elizaLogger.log("initializeClients", clientTypes, "for", character.name);

    // Start Auto Client if "auto" detected as a configured client
    if (clientTypes.includes(Clients.AUTO)) {
        const autoClient = await AutoClientInterface.start(runtime);
        if (autoClient) clients.auto = autoClient;
    }

    if (clientTypes.includes(Clients.DISCORD)) {
        const discordClient = await DiscordClientInterface.start(runtime);
        if (discordClient) clients.discord = discordClient;
    }

    if (clientTypes.includes(Clients.TELEGRAM)) {
        const telegramClient = await TelegramClientInterface.start(runtime);
        if (telegramClient) clients.telegram = telegramClient;
    }

    if (clientTypes.includes(Clients.TWITTER)) {
        const twitterClient = await TwitterClientInterface.start(runtime);
        if (twitterClient) {
            clients.twitter = twitterClient;
        }
    }

    elizaLogger.log("client keys", Object.keys(clients));

    function determineClientType(client: Client): string {
        // Check if client has a direct type identifier
        if ("type" in client) {
            return (client as any).type;
        }

        // Check constructor name
        const constructorName = client.constructor?.name;
        if (constructorName && !constructorName.includes("Object")) {
            return constructorName.toLowerCase().replace("client", "");
        }

        // Fallback: Generate a unique identifier
        return `client_${Date.now()}`;
    }

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    const startedClient = await client.start(runtime);
                    const clientType = determineClientType(client);
                    elizaLogger.debug(
                        `Initializing client of type: ${clientType}`
                    );
                    clients[clientType] = startedClient;
                }
            }
        }
    }

    return clients;
}

function getSecret(character: Character, secret: string) {
    return character.settings?.secrets?.[secret] || process.env[secret];
}

let nodePlugin: any | undefined;

export async function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
): Promise<AgentRuntime> {
    elizaLogger.log(`Creating runtime for character ${character.name}`);

    nodePlugin ??= createNodePlugin();

    const teeMode = getSecret(character, "TEE_MODE") || "OFF";
    const walletSecretSalt = getSecret(character, "WALLET_SECRET_SALT");

    // Validate TEE configuration
    if (teeMode !== TEEMode.OFF && !walletSecretSalt) {
        elizaLogger.error(
            "WALLET_SECRET_SALT required when TEE_MODE is enabled"
        );
        throw new Error("Invalid TEE configuration");
    }

    let goatPlugin: any | undefined;

    if (getSecret(character, "EVM_PRIVATE_KEY")) {
        goatPlugin = await createGoatPlugin((secret) =>
            getSecret(character, secret)
        );
    }

    // Initialize Reclaim adapter if environment variables are present
    // let verifiableInferenceAdapter;
    // if (
    //     process.env.RECLAIM_APP_ID &&
    //     process.env.RECLAIM_APP_SECRET &&
    //     process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    // ) {
    //     verifiableInferenceAdapter = new ReclaimAdapter({
    //         appId: process.env.RECLAIM_APP_ID,
    //         appSecret: process.env.RECLAIM_APP_SECRET,
    //         modelProvider: character.modelProvider,
    //         token,
    //     });
    //     elizaLogger.log("Verifiable inference adapter initialized");
    // }
    // Initialize Opacity adapter if environment variables are present
    let verifiableInferenceAdapter;
    if (
        process.env.OPACITY_TEAM_ID &&
        process.env.OPACITY_CLOUDFLARE_NAME &&
        process.env.OPACITY_PROVER_URL &&
        process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    ) {
        verifiableInferenceAdapter = new OpacityAdapter({
            teamId: process.env.OPACITY_TEAM_ID,
            teamName: process.env.OPACITY_CLOUDFLARE_NAME,
            opacityProverUrl: process.env.OPACITY_PROVER_URL,
            modelProvider: character.modelProvider,
            token: token,
        });
        elizaLogger.log("Verifiable inference adapter initialized");
        elizaLogger.log("teamId", process.env.OPACITY_TEAM_ID);
        elizaLogger.log("teamName", process.env.OPACITY_CLOUDFLARE_NAME);
        elizaLogger.log("opacityProverUrl", process.env.OPACITY_PROVER_URL);
        elizaLogger.log("modelProvider", character.modelProvider);
        elizaLogger.log("token", token);
    }
    if (
        process.env.PRIMUS_APP_ID &&
        process.env.PRIMUS_APP_SECRET &&
        process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    ) {
        verifiableInferenceAdapter = new PrimusAdapter({
            appId: process.env.PRIMUS_APP_ID,
            appSecret: process.env.PRIMUS_APP_SECRET,
            attMode: "proxytls",
            modelProvider: character.modelProvider,
            token,
        });
        elizaLogger.log("Verifiable inference primus adapter initialized");
    }

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        // character.plugins are handled when clients are added
        plugins: [
            bootstrapPlugin,
            nodePlugin,
            getSecret(character, "SOLANA_PUBLIC_KEY") ||
            (getSecret(character, "WALLET_PUBLIC_KEY") &&
                !getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith("0x"))
                ? solanaPlugin
                : null,
            getSecret(character, "SOLANA_PRIVATE_KEY")
                ? solanaAgentkitPlguin
                : null,
            getSecret(character, "AUTONOME_JWT_TOKEN") ? autonomePlugin : null,
            (getSecret(character, "NEAR_ADDRESS") ||
                getSecret(character, "NEAR_WALLET_PUBLIC_KEY")) &&
            getSecret(character, "NEAR_WALLET_SECRET_KEY")
                ? nearPlugin
                : null,
            getSecret(character, "EVM_PUBLIC_KEY") ||
            (getSecret(character, "WALLET_PUBLIC_KEY") &&
                getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith("0x"))
                ? evmPlugin
                : null,
            (getSecret(character, "SOLANA_PUBLIC_KEY") ||
                (getSecret(character, "WALLET_PUBLIC_KEY") &&
                    !getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith(
                        "0x"
                    ))) &&
            getSecret(character, "SOLANA_ADMIN_PUBLIC_KEY") &&
            getSecret(character, "SOLANA_PRIVATE_KEY") &&
            getSecret(character, "SOLANA_ADMIN_PRIVATE_KEY")
                ? nftGenerationPlugin
                : null,
            getSecret(character, "ZEROG_PRIVATE_KEY") ? zgPlugin : null,
            getSecret(character, "COINMARKETCAP_API_KEY")
                ? coinmarketcapPlugin
                : null,
            getSecret(character, "COINBASE_COMMERCE_KEY")
                ? coinbaseCommercePlugin
                : null,
            getSecret(character, "FAL_API_KEY") ||
            getSecret(character, "OPENAI_API_KEY") ||
            getSecret(character, "VENICE_API_KEY") ||
            getSecret(character, "NINETEEN_AI_API_KEY") ||
            getSecret(character, "HEURIST_API_KEY") ||
            getSecret(character, "LIVEPEER_GATEWAY_URL")
                ? imageGenerationPlugin
                : null,
            ...(getSecret(character, "COINBASE_API_KEY") &&
            getSecret(character, "COINBASE_PRIVATE_KEY")
                ? [
                      coinbaseMassPaymentsPlugin,
                      tradePlugin,
                      tokenContractPlugin,
                      advancedTradePlugin,
                  ]
                : []),
            ...(teeMode !== TEEMode.OFF && walletSecretSalt ? [teePlugin] : []),
            getSecret(character, "SGX") ? sgxPlugin : null,
            getSecret(character, "ENABLE_TEE_LOG") &&
            ((teeMode !== TEEMode.OFF && walletSecretSalt) ||
                getSecret(character, "SGX"))
                ? teeLogPlugin
                : null,
            getSecret(character, "COINBASE_API_KEY") &&
            getSecret(character, "COINBASE_PRIVATE_KEY") &&
            getSecret(character, "COINBASE_NOTIFICATION_URI")
                ? webhookPlugin
                : null,
            goatPlugin,
            getSecret(character, "EVM_PROVIDER_URL") ? goatPlugin : null,
            getSecret(character, "ABSTRACT_PRIVATE_KEY")
                ? abstractPlugin
                : null,
            getSecret(character, "FLOW_ADDRESS") &&
            getSecret(character, "ECHOCHAMBERS_API_URL") &&
            getSecret(character, "HYPERLIQUID_PRIVATE_KEY")
                ? hyperliquidPlugin
                : null,
            getSecret(character, "HYPERLIQUID_TESTNET")
                ? hyperliquidPlugin
                : null,
        ].filter(Boolean),
        providers: [],
        actions: [],
        services: [],
        managers: [],
        cacheManager: cache,
        fetch: logFetch,
        verifiableInferenceAdapter,
    });
}

function initializeFsCache(baseDir: string, character: Character) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cacheDir = path.resolve(baseDir, character.id, "cache");

    const cache = new CacheManager(new FsCacheAdapter(cacheDir));
    return cache;
}

function initializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cache = new CacheManager(new DbCacheAdapter(db, character.id));
    return cache;
}

function initializeCache(
    cacheStore: string,
    character: Character,
    baseDir?: string,
    db?: IDatabaseCacheAdapter
) {
    switch (cacheStore) {
        case CacheStore.REDIS:
            if (process.env.REDIS_URL) {
                elizaLogger.info("Connecting to Redis...");
                const redisClient = new RedisClient(process.env.REDIS_URL);
                if (!character?.id) {
                    throw new Error(
                        "CacheStore.REDIS requires id to be set in character definition"
                    );
                }
                return new CacheManager(
                    new DbCacheAdapter(redisClient, character.id) // Using DbCacheAdapter since RedisClient also implements IDatabaseCacheAdapter
                );
            } else {
                throw new Error("REDIS_URL environment variable is not set.");
            }

        case CacheStore.DATABASE:
            if (db) {
                elizaLogger.info("Using Database Cache...");
                return initializeDbCache(character, db);
            } else {
                throw new Error(
                    "Database adapter is not provided for CacheStore.Database."
                );
            }

        case CacheStore.FILESYSTEM:
            elizaLogger.info("Using File System Cache...");
            if (!baseDir) {
                throw new Error(
                    "baseDir must be provided for CacheStore.FILESYSTEM."
                );
            }
            return initializeFsCache(baseDir, character);

        default:
            throw new Error(
                `Invalid cache store: ${cacheStore} or required configuration missing.`
            );
    }
}

async function startAgent(
    character: Character,
    directClient: DirectClient
): Promise<AgentRuntime> {
    let db: IDatabaseAdapter & IDatabaseCacheAdapter;
    try {
        if (character.settings?.secrets) {
            if (character.settings.secrets.TWITTER_PASSWORD_ENCRYPTED) {
                character.settings.secrets.TWITTER_PASSWORD = decrypt(
                    character.settings.secrets.TWITTER_PASSWORD_ENCRYPTED
                );
                delete character.settings.secrets.TWITTER_PASSWORD_ENCRYPTED;
            }
            /*if (character.settings.secrets.TWITTER_COOKIE_ENCRYPTED) {
                character.settings.secrets.TWITTER_COOKIE = decrypt(
                    character.settings.secrets.TWITTER_COOKIE_ENCRYPTED
                );
                delete character.settings.secrets.TWITTER_COOKIE_ENCRYPTED;
            }*/
        }

        character.id ??= stringToUuid(character.settings?.secrets.id);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);
        const dataDir = path.join(__dirname, "../data");

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        db = initializeDatabase(dataDir) as IDatabaseAdapter &
            IDatabaseCacheAdapter;

        await db.init();

        const cache = initializeCache(
            process.env.CACHE_STORE ?? CacheStore.DATABASE,
            character,
            "",
            db
        ); // "" should be replaced with dir for file system caching. THOUGHTS: might probably make this into an env
        const runtime: AgentRuntime = await createAgent(
            character,
            db,
            cache,
            token
        );

        // start services/plugins/process knowledge
        await runtime.initialize();

        // start assigned clients
        runtime.clients = await initializeClients(character, runtime);

        // add to container
        directClient.registerAgent(runtime);

        // report to console
        elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        elizaLogger.error(error);
        if (db) {
            await db.close();
        }
        throw error;
    }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
            }
        });

        server.once("listening", () => {
            server.close();
            resolve(true);
        });

        server.listen(port);
    });
};

const startAgents = async () => {
    const directClient = new DirectClient();
    let serverPort = parseInt(settings.SERVER_PORT || "3000");

    try {
        // Load all existing agents
        const characters = await loadCharacters();

        // Start all existing agents
        for (const character of characters) {
            const runtime = await startAgent(character, directClient);
            directClient.registerAgent(runtime);
            elizaLogger.log(`Agent ${character.name} started successfully.`);
        }

        // Setup RabbitMQ for handling new agents and credential updates
        await setupRabbitMQ(directClient);

        // Find available port
        while (!(await checkPortAvailable(serverPort))) {
            elizaLogger.warn(
                `Port ${serverPort} is in use, trying ${serverPort + 1}`
            );
            serverPort++;
        }

        // Start the DirectClient server
        directClient.start(serverPort);

        if (serverPort !== parseInt(settings.SERVER_PORT || "3000")) {
            elizaLogger.log(`Server started on alternate port ${serverPort}`);
        }

        elizaLogger.log("All agents started successfully. Server is ready.");
    } catch (error) {
        elizaLogger.error(
            "Error starting agents or setting up RabbitMQ:",
            error
        );
    }
};

startAgents().catch((error) => {
    elizaLogger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

startAgents().catch((error) => {
    elizaLogger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

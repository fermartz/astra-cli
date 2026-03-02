export {
  ASTRA_DIR,
  CACHE_DIR,
  getRoot,
  configPath,
  agentDir,
  credentialsPath,
  walletPath,
  cachePath,
  ensureDir,
  ensureBaseStructure,
} from "./paths.js";

export {
  ConfigSchema,
  CredentialsSchema,
  WalletSchema,
  RegisterResponseSchema,
  AgentNameSchema,
  type Config,
  type Credentials,
  type Wallet,
  type RegisterResponse,
} from "./schema.js";

export {
  isConfigured,
  loadConfig,
  saveConfig,
  getActiveAgent,
  setActiveAgent,
  loadCredentials,
  saveCredentials,
  loadWallet,
  saveWallet,
  listAgents,
} from "./store.js";

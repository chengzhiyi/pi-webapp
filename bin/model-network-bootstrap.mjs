// Loaded before the SDK only by the managed Pi child. Importing the extension in
// an existing user TUI never installs global transport configuration.
import { configureOwnedProcessNetworking } from './model-network.mjs';
if (process.env.PI_WEBAPP_LAUNCHER_NONCE) configureOwnedProcessNetworking();

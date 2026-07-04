// models/drivers/chatgpt.js — ChatGPT driver: ensureChat with projects, model
// picker (Pro/thinking variants), and deep research. All selector data comes
// from the registry descriptor; flows are the shared machinery. Provider-
// specific quirks discovered live belong in the createDriver overrides here.
import { createDriver } from './common.js';

export default createDriver('chatgpt');

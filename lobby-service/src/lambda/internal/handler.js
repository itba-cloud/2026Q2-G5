import { createHttpHandler } from '../../shared/http/handler.js';
import { createInternalRuntime as createRuntime } from './runtime.js';
import { createInternalApp } from './app.js';

export function createInternalHandler(initialize = createRuntime) {
  return createHttpHandler('internal', initialize, createInternalApp);
}

export const handler = createInternalHandler();

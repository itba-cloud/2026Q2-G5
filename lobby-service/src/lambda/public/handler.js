import { createHttpHandler } from '../../shared/http/handler.js';
import { createHttpRuntime as createRuntime } from '../../shared/runtime/http.js';
import { createPublicApp } from './app.js';

export function createPublicHandler(initialize = createRuntime) {
  return createHttpHandler('public', initialize, createPublicApp);
}

export const handler = createPublicHandler();

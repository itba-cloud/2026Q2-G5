import serverlessExpress from '@codegenie/serverless-express';

export function createHttpHandler(profile, initialize, createApp) {
  let ready;
  return async (event, context = {}) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (!ready) ready = initialize().then(runtime => {
      const app = createApp(runtime);
      return serverlessExpress({ app });
    }).catch(err => { ready = undefined; throw err; });
    try {
      const handler = await ready;
      return await handler(event, context);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'http.unavailable', profile, error: err.name }));
      return { statusCode: 503, headers: { 'content-type': 'application/json' },
        isBase64Encoded: false, body: JSON.stringify({ success: false, error: 'Servicio temporalmente no disponible' }) };
    }
  };
}

import assert from 'assert';

global.window = {
  location: {
    protocol: 'http:',
    hostname: 'client-bucket.s3-website-us-east-1.amazonaws.com',
  },
  ELASTIC_WORLDS_RUNTIME_CONFIG: {
    lobbyApiUrl: 'http://elastic-worlds-alb.us-east-1.elb.amazonaws.com',
    metricsApiUrl: 'http://elastic-worlds-alb.us-east-1.elb.amazonaws.com/api/metrics',
  },
};

const { ClientConfig } = await import('../js/config.js');

assert.strictEqual(
  ClientConfig.lobbyApiUrl,
  'http://elastic-worlds-alb.us-east-1.elb.amazonaws.com',
  'the client uses the Lobby URL generated at deployment time'
);
assert.strictEqual(
  ClientConfig.metricsApiUrl,
  'http://elastic-worlds-alb.us-east-1.elb.amazonaws.com/api/metrics',
  'the dashboard uses the ALB metrics route generated at deployment time'
);

console.log('Runtime deployment configuration test passed.');

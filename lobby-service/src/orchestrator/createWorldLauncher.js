import { DockerContainerLauncher } from './DockerContainerLauncher.js';
import { FargateWorldLauncher } from './FargateWorldLauncher.js';

/** Picks the world launcher from WORLD_LAUNCHER (docker | fargate). */
export function createWorldLauncher(config) {
  const kind = config.worldLauncher || 'docker';
  if (kind === 'fargate') {
    return new FargateWorldLauncher({ ...config.fargate, publicWsProtocol: config.publicWsProtocol });
  }
  if (kind !== 'docker') throw new Error(`WORLD_LAUNCHER debe ser docker o fargate (recibido: ${kind})`);
  return new DockerContainerLauncher({ useMock: config.useDockerMock });
}

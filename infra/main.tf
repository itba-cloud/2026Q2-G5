locals {
  # Sin NAT, todo lo que corre en las subredes privadas llega a los servicios de
  # AWS por estos endpoints. Agrupados por quien los consume: cada grupo tiene su
  # SG y security.tf define quien entra a cada uno.
  interface_endpoints = {
    # Kinesis no tiene endpoint de tipo Gateway. Productores de telemetria:
    # tasks de mundos y NPC.
    telemetry = ["kinesis-streams"]
    # Las Lambdas HTTP y la de mantenimiento arrancan los workflows de Step Functions.
    workflows = ["states"]
    # Lambdas del Lobby, NPC y Metrics leen sus contraseñas de Secrets Manager.
    secrets = ["secretsmanager"]
    # Las tasks de Fargate bajan la imagen por ECR (api + dkr; las capas salen
    # de S3 por el gateway endpoint) y mandan logs a CloudWatch.
    containers = ["ecr.api", "ecr.dkr", "logs"]
    # Las Lambdas de lifecycle y mantenimiento lanzan, consultan y frenan las
    # tasks de mundos (ECS) y leen su IP publica (EC2).
    world_api = ["ecs", "ec2"]
  }
}

module "network" {
  source = "./modules/network"

  name   = var.project_name
  region = var.aws_region
  azs    = slice(data.aws_availability_zones.available.names, 0, 2)

  # Una /24 por subred (10.0.N.0/24 con el CIDR default), indice N por capa y AZ.
  vpc_cidr = var.vpc_cidr
  subnet_cidrs = {
    public      = [for index in [0, 1] : cidrsubnet(var.vpc_cidr, 8, index)]
    private     = [for index in [10, 11] : cidrsubnet(var.vpc_cidr, 8, index)]
    database    = [for index in [20, 21] : cidrsubnet(var.vpc_cidr, 8, index)]
    elasticache = [for index in [30, 31] : cidrsubnet(var.vpc_cidr, 8, index)]
  }

  interface_endpoints = local.interface_endpoints

  # El Lobby y el NPC usan RDS desde las subredes privadas. Redis tambien lo
  # usan las tasks de mundos, que viven en las publicas.
  database_client_tiers    = ["private"]
  elasticache_client_tiers = ["private", "public"]
}

module "data" {
  source = "./modules/data"

  name               = var.project_name
  subnet_ids         = module.network.database_subnet_ids
  security_group_ids = [aws_security_group.rds.id]
  username           = var.db_username
  # RDS genera la contraseña y la guarda (y rota) en Secrets Manager: nunca pasa
  # por Terraform ni queda en su estado.
  manage_master_user_password = true
  multi_az                    = var.db_multi_az

  cache_subnet_ids         = module.network.elasticache_subnet_ids
  cache_security_group_ids = [aws_security_group.redis.id]
}

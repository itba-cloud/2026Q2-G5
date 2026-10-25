locals {
  # Sufijo por posicion de la AZ: subred 0 -> "a", subred 1 -> "b".
  suffixes = [for index in range(length(var.azs)) : substr("abcdef", index, 1)]

  tier_cidrs = {
    public  = var.subnet_cidrs.public
    private = var.subnet_cidrs.private
  }

  # Las NACL son stateless y no aceptan security groups como origen: cada subred
  # cliente necesita una regla de entrada al puerto del servicio y una de salida
  # a sus puertos efimeros. Todo lo demas queda denegado por la regla "*".
  database_client_cidrs    = flatten([for tier in var.database_client_tiers : local.tier_cidrs[tier]])
  elasticache_client_cidrs = flatten([for tier in var.elasticache_client_tiers : local.tier_cidrs[tier]])

  database_acl_inbound = [for index, cidr in local.database_client_cidrs : {
    rule_number = 100 + 10 * index, rule_action = "allow", protocol = "tcp",
    from_port   = var.database_port, to_port = var.database_port, cidr_block = cidr
  }]
  database_acl_outbound = [for index, cidr in local.database_client_cidrs : {
    rule_number = 100 + 10 * index, rule_action = "allow", protocol = "tcp",
    from_port   = 1024, to_port = 65535, cidr_block = cidr
  }]
  # Replicacion entre los nodos de cache: la replica abre la conexion al puerto
  # del primario, asi que entre las subredes de cache entran el puerto y las
  # respuestas a puertos efimeros, y salen los efimeros (que incluyen el puerto).
  replication_cidrs = var.elasticache_replication ? var.subnet_cidrs.elasticache : []

  elasticache_acl_inbound = concat(
    [for index, cidr in local.elasticache_client_cidrs : {
      rule_number = 100 + 10 * index, rule_action = "allow", protocol = "tcp",
      from_port   = var.elasticache_port, to_port = var.elasticache_port, cidr_block = cidr
    }],
    [for index, cidr in local.replication_cidrs : {
      rule_number = 300 + 10 * index, rule_action = "allow", protocol = "tcp",
      from_port   = var.elasticache_port, to_port = var.elasticache_port, cidr_block = cidr
    }],
    [for index, cidr in local.replication_cidrs : {
      rule_number = 400 + 10 * index, rule_action = "allow", protocol = "tcp",
      from_port   = 1024, to_port = 65535, cidr_block = cidr
    }],
  )
  elasticache_acl_outbound = concat(
    [for index, cidr in local.elasticache_client_cidrs : {
      rule_number = 100 + 10 * index, rule_action = "allow", protocol = "tcp",
      from_port   = 1024, to_port = 65535, cidr_block = cidr
    }],
    [for index, cidr in local.replication_cidrs : {
      rule_number = 300 + 10 * index, rule_action = "allow", protocol = "tcp",
      from_port   = 1024, to_port = 65535, cidr_block = cidr
    }],
  )

  # Servicio de interfaz => grupo de consumidores que lo usa.
  interface_endpoint_groups = merge([
    for group, services in var.interface_endpoints : { for service in services : service => group }
  ]...)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.21.0"

  name                 = var.name
  cidr                 = var.vpc_cidr
  azs                  = var.azs
  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnets          = var.subnet_cidrs.public
  public_subnet_names     = [for index, _ in var.subnet_cidrs.public : "${var.name}-public-${local.suffixes[index]}"]
  public_subnet_tags      = { Tier = "public" }
  map_public_ip_on_launch = true

  private_subnets      = var.subnet_cidrs.private
  private_subnet_names = [for index, _ in var.subnet_cidrs.private : "${var.name}-private-${local.suffixes[index]}"]
  private_subnet_tags  = { Tier = "private" }

  # Cada base de datos en su propia subred, separada de la capa de aplicacion.
  # RDS exige un DB subnet group con al menos dos AZ, aunque Multi-AZ este apagado.
  database_subnets      = var.subnet_cidrs.database
  database_subnet_names = [for index, _ in var.subnet_cidrs.database : "${var.name}-db-${local.suffixes[index]}"]
  database_subnet_tags  = { Tier = "data" }

  elasticache_subnets      = var.subnet_cidrs.elasticache
  elasticache_subnet_names = [for index, _ in var.subnet_cidrs.elasticache : "${var.name}-redis-${local.suffixes[index]}"]
  elasticache_subnet_tags  = { Tier = "data" }

  # Sin NAT. single_nat_gateway no crea ningun NAT (eso depende solo de
  # enable_nat_gateway): hace que el modulo use una route table privada y una de
  # database compartidas por todas las AZ en vez de una por subred.
  enable_nat_gateway = false
  single_nat_gateway = true

  # Route tables propias para datos, solo con la ruta local de la VPC: aunque se
  # agregue un NAT a la privada, las bases de datos siguen sin salida a Internet.
  create_database_subnet_route_table     = true
  create_database_internet_gateway_route = false
  create_database_nat_gateway_route      = false
  create_elasticache_subnet_route_table  = true

  # Los subnet groups son parte del almacen (modules/data), no de la red.
  create_database_subnet_group    = false
  create_elasticache_subnet_group = false

  database_dedicated_network_acl = true
  database_inbound_acl_rules     = local.database_acl_inbound
  database_outbound_acl_rules    = local.database_acl_outbound

  elasticache_dedicated_network_acl = true
  elasticache_inbound_acl_rules     = local.elasticache_acl_inbound
  elasticache_outbound_acl_rules    = local.elasticache_acl_outbound

  # Fijados aunque coincidan con el default: el Learner Lab no permite crear
  # roles IAM, y Flow Logs a CloudWatch crearia uno.
  enable_flow_log                     = false
  create_flow_log_cloudwatch_iam_role = false

  # No adoptamos el SG, la NACL ni la route table default de la VPC.
  manage_default_security_group = false
  manage_default_network_acl    = false
  manage_default_route_table    = false

  vpc_tags                     = { Name = "${var.name}-vpc" }
  igw_tags                     = { Name = "${var.name}-igw" }
  public_route_table_tags      = { Name = "${var.name}-rt-public" }
  private_route_table_tags     = { Name = "${var.name}-rt-private" }
  database_route_table_tags    = { Name = "${var.name}-rt-db" }
  elasticache_route_table_tags = { Name = "${var.name}-rt-redis" }
  database_acl_tags            = { Name = "${var.name}-nacl-db" }
  elasticache_acl_tags         = { Name = "${var.name}-nacl-redis" }
}

# Un SG por grupo de consumidores, sin reglas: quien llama al modulo agrega el
# ingreso desde cada consumidor. Sin bloques inline, esas reglas externas no se
# revocan en cada apply.
resource "aws_security_group" "endpoints" {
  for_each    = var.interface_endpoints
  name        = "${var.name}-vpce-${each.key}"
  description = "Interface endpoints for ${join(", ", each.value)}"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${var.name}-vpce-${each.key}"
  }
}

module "endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "5.21.0"

  vpc_id                = module.vpc.vpc_id
  subnet_ids            = module.vpc.private_subnets
  create_security_group = false

  endpoints = merge(
    {
      for service in var.gateway_endpoints : service => {
        service          = service
        service_type     = "Gateway"
        service_endpoint = "com.amazonaws.${var.region}.${service}"
        route_table_ids  = concat(module.vpc.public_route_table_ids, module.vpc.private_route_table_ids)
        tags             = { Name = "${var.name}-vpce-${service}" }
      }
    },
    {
      # Con DNS privado, los SDK resuelven <servicio>.<region>.amazonaws.com a
      # las ENI de las subredes privadas sin cambiar nada en los clientes.
      for service, group in local.interface_endpoint_groups : service => {
        service             = service
        service_endpoint    = "com.amazonaws.${var.region}.${service}"
        private_dns_enabled = true
        security_group_ids  = [aws_security_group.endpoints[group].id]
        tags                = { Name = "${var.name}-vpce-${replace(service, ".", "-")}" }
      }
    },
  )
}

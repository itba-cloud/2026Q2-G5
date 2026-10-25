resource "aws_security_group" "lobby_http" {
  for_each    = toset(["public", "internal"])
  name        = "${var.project_name}-lobby-${each.key}-lambda"
  description = "Lobby HTTP Lambda; invoked directly by ALB, no ingress sockets"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "lobby_lifecycle" {
  name        = "${var.project_name}-lobby-lifecycle-lambda"
  description = "World lifecycle task Lambda"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "lobby_maintenance" {
  name        = "${var.project_name}-lobby-maintenance"
  description = "Scheduled maintenance Lambda, no HTTP ingress"
  vpc_id      = module.network.vpc_id
}

locals {
  lobby_runtime_sgs = merge(
    { for name, sg in aws_security_group.lobby_http : name => sg.id },
    { lifecycle = aws_security_group.lobby_lifecycle.id, maintenance = aws_security_group.lobby_maintenance.id }
  )
  lobby_dispatch_sgs = merge(
    { for name, sg in aws_security_group.lobby_http : name => sg.id },
    { maintenance = aws_security_group.lobby_maintenance.id }
  )
  lobby_effect_sgs = {
    lifecycle = aws_security_group.lobby_lifecycle.id, maintenance = aws_security_group.lobby_maintenance.id
  }
}

resource "aws_security_group_rule" "lobby_runtime_db" {
  for_each                 = local.lobby_runtime_sgs
  type                     = "egress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = each.value
  source_security_group_id = aws_security_group.rds.id
}

# Sin cliente de S3: las funciones solo salen a 443 para leer la contraseña de RDS.
resource "aws_security_group_rule" "lobby_runtime_secrets" {
  for_each                 = local.lobby_runtime_sgs
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = each.value
  source_security_group_id = module.network.endpoint_security_group_ids["secrets"]
}

resource "aws_security_group_rule" "lobby_maintenance_endpoints" {
  for_each                 = local.lobby_dispatch_sgs
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = each.value
  source_security_group_id = module.network.endpoint_security_group_ids["workflows"]
}

resource "aws_security_group_rule" "lobby_internal_redis" {
  type                     = "egress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.lobby_http["internal"].id
  source_security_group_id = aws_security_group.redis.id
}

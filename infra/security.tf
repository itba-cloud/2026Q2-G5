resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Public HTTP entry point"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "HTTP from players"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "internal_alb" {
  name        = "${var.project_name}-internal-alb-sg"
  description = "Private internal HTTP entry point"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "World task status reports and shutdowns"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.world_task.id]
  }

  ingress {
    description     = "Scraping from Metrics Service"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.metrics.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "npc" {
  name        = "${var.project_name}-npc-sg"
  description = "NPC service"
  vpc_id      = module.network.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "metrics" {
  name        = "${var.project_name}-metrics-sg"
  description = "Metrics service"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "ALB metrics route"
    from_port       = 3100
    to_port         = 3100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "redis" {
  name        = "${var.project_name}-redis-sg"
  description = "Redis Pub/Sub"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "World chat"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.world_task.id]
  }

  ingress {
    description     = "Lobby announcements"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.lobby_http["internal"].id]
  }

  ingress {
    description = "Replication between the cache nodes"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "PostgreSQL registry"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "Lobby registry access"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = values(local.lobby_runtime_sgs)
  }

  # Inline como la del Lobby: una aws_security_group_rule aparte sobre este SG se
  # revoca en cada apply. La NACL de db-a/db-b ya acepta 5432 desde private-a/private-b.
  ingress {
    description     = "NPC replicas take world leases"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.npc.id]
  }
}

# Quien entra a cada grupo de endpoints de interfaz (ver local.interface_endpoints).
locals {
  endpoint_consumers = {
    telemetry  = { world_task = aws_security_group.world_task.id, npc = aws_security_group.npc.id }
    workflows  = local.lobby_dispatch_sgs
    containers = { world_task = aws_security_group.world_task.id, npc = aws_security_group.npc.id, metrics = aws_security_group.metrics.id }
    secrets    = merge(local.lobby_runtime_sgs, { npc = aws_security_group.npc.id, metrics = aws_security_group.metrics.id })
    world_api  = local.lobby_effect_sgs
  }
  endpoint_ingress = merge([
    for group, consumers in local.endpoint_consumers : {
      for name, sg in consumers : "${group}-${name}" => { group = group, consumer = name, sg = sg }
    }
  ]...)
}

resource "aws_security_group_rule" "endpoint_ingress" {
  for_each                 = local.endpoint_ingress
  description              = "${each.value.group} endpoints from ${each.value.consumer}"
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = module.network.endpoint_security_group_ids[each.value.group]
  source_security_group_id = each.value.sg
}

resource "aws_lb" "main" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids

  tags = {
    Name = "${var.project_name}-alb"
  }
}

# Las tasks de Fargate (awsvpc) se registran por IP; el ECS service de Metrics
# las da de alta y de baja.
resource "aws_lb_target_group" "metrics" {
  name        = "${var.project_name}-metrics"
  port        = 3100
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.network.vpc_id

  health_check {
    path = "/health"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = module.lobby.target_group_arns["public"]
  }
}

resource "aws_lb_listener_rule" "metrics" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.metrics.arn
  }

  condition {
    path_pattern {
      values = ["/api/metrics*"]
    }
  }
}

resource "aws_lb_listener_rule" "block_hosts_api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "Access denied: internal endpoint" })
      status_code  = "403"
    }
  }

  condition {
    path_pattern {
      values = ["/api/hosts*", "/hosts*"]
    }
  }
}

resource "aws_lb_listener_rule" "block_world_control_api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 21

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "Access denied: internal endpoint" })
      status_code  = "403"
    }
  }

  condition {
    path_pattern {
      values = ["*/shutdown", "*/stop", "*/status"]
    }
  }
}

resource "aws_lb_listener_rule" "block_world_delete" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 22

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "Access denied: delete method disabled" })
      status_code  = "403"
    }
  }

  condition {
    http_request_method {
      values = ["DELETE"]
    }
  }
}

# ==============================================================================
# Internal Application Load Balancer (Private VPC traffic only)
# ==============================================================================

resource "aws_lb" "internal" {
  name               = "${var.project_name}-internal-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.internal_alb.id]
  subnets            = module.network.private_subnet_ids

  tags = {
    Name = "${var.project_name}-internal-alb"
  }
}

resource "aws_lb_listener" "internal_http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = module.lobby.target_group_arns["internal"]
  }
}

resource "aws_lb_listener_rule" "block_announcements" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 23
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "Access denied: internal endpoint" })
      status_code  = "403"
    }
  }
  condition {
    path_pattern { values = ["/announce*", "/api/announce*"] }
  }
}

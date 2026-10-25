variable "name" {
  description = "Task definition family, ECR repository name and log group suffix (/ecs/<name>)."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "container_name" {
  description = "Container name, also used as log stream prefix."
  type        = string
}

variable "region" {
  type = string
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "port" {
  type = number
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "health_check" {
  description = "Container health check, in the ECS task definition format. Null skips it."
  type        = any
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "execution_role_arn" {
  description = "Existing role ECS uses to pull the image and write logs. The Learner Lab does not allow creating roles."
  type        = string
}

variable "task_role_arn" {
  description = "Existing role the container runs with."
  type        = string
}

variable "image" {
  description = "Image URI the tasks pull. Ignored when push_image is set."
  type        = string
  default     = ""
}

variable "push_image" {
  description = "Create an immutable ECR repository and push source_image to it. Fargate tasks without Internet access can only pull from ECR."
  type = object({
    source_image = string
    script       = string
    account_id   = string
  })
  default = null
}

variable "service" {
  description = "Run the task as an ECS service. Null only registers the task definition, for tasks launched by someone else. load_balancer registers the tasks in an existing target group (target_type ip) and gives them a health check grace period in seconds."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
    assign_public_ip   = bool
    desired_count      = number
    load_balancer = optional(object({
      target_group_arn          = string
      health_check_grace_period = number
    }))
    autoscaling = optional(object({
      min_count          = number
      max_count          = number
      cpu_target         = number
      scale_out_cooldown = number
      scale_in_cooldown  = number
    }))
  })
  default = null
}

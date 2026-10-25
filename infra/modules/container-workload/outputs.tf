output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "container_name" {
  value = var.container_name
}

output "image" {
  description = "Image URI the task definition uses."
  value       = local.image
}

output "repository_url" {
  description = "ECR repository the image is pushed to; null when the image is supplied."
  value       = one(aws_ecr_repository.this[*].repository_url)
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "service_name" {
  description = "Name of the ECS service; null without a service."
  value       = one(aws_ecs_service.this[*].name)
}

output "target_group_arn" {
  description = "Target group the service registers its tasks in; null without a load balancer."
  value       = try(var.service.load_balancer.target_group_arn, null)
}

output "service_network" {
  description = "Network configuration of the ECS service; null without a service."
  value       = var.service == null ? null : { subnet_ids = var.service.subnet_ids, assign_public_ip = var.service.assign_public_ip, desired_count = var.service.desired_count }
}

output "autoscaling" {
  description = "Capacity range of the service; null without autoscaling."
  value       = length(aws_appautoscaling_target.this) == 0 ? null : { min = aws_appautoscaling_target.this[0].min_capacity, max = aws_appautoscaling_target.this[0].max_capacity }
}

output "pushes_image" {
  description = "Whether the module creates an ECR repository and pushes the source image to it."
  value       = var.push_image != null
}

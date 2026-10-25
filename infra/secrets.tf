# Contraseña del dashboard de Metrics. La genera Terraform como valor efímero y la
# escribe con secret_string_wo: llega a Secrets Manager pero no queda en el estado.
# Incrementar metrics_password_version genera una nueva y cambia la task definition
# de Metrics, asi que ECS reemplaza las tasks y estas la leen al arrancar.
ephemeral "random_password" "metrics" {
  length = 32
  # Basic Auth separa usuario y contraseña en el primer ":"; sin especiales se
  # evitan problemas de escape en la URL del dashboard.
  special = false
}

resource "aws_secretsmanager_secret" "metrics_password" {
  name        = "${var.project_name}-metrics-password"
  description = "Basic Auth password of the Metrics dashboard (user ${var.metrics_user})."
  # Sin ventana de recuperacion: un destroy seguido de un apply reutiliza el nombre.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "metrics_password" {
  secret_id                = aws_secretsmanager_secret.metrics_password.id
  secret_string_wo         = ephemeral.random_password.metrics.result
  secret_string_wo_version = var.metrics_password_version
}

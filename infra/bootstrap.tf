# Fresh Learner Lab deployments build from source by default.
variable "bootstrap_from_source" {
  description = "Prepare buckets, images, Lambda ZIPs and the Flink JAR from this checkout. Requires local Docker and AWS CLI."
  type        = bool
  default     = true
}

variable "cleanup_bootstrap_buckets" {
  description = "On destroy, empty/delete only buckets created and tagged by this bootstrap. Enable only for disposable environments."
  type        = bool
  default     = false
}

variable "start_telemetry_application" {
  description = "Start the Flink job after provisioning. May remain false during Lobby-only verification."
  type        = bool
  default     = true
}

data "external" "lab_assets" {
  count   = var.bootstrap_from_source ? 1 : 0
  program = ["python3", "${path.module}/../scripts/prepare-lab-assets.py"]
  query   = { project = var.project_name }
}

resource "terraform_data" "lab_buckets" {
  count = var.bootstrap_from_source ? 1 : 0
  input = {
    project = var.project_name
    region  = var.aws_region
    account = data.aws_caller_identity.current.account_id
    script  = "${path.module}/../scripts/lab-buckets.py"
    cleanup = tostring(var.cleanup_bootstrap_buckets)
  }
  provisioner "local-exec" {
    command = "python3 '${self.input.script}' create"
    environment = {
      PROJECT_NAME        = self.input.project
      AWS_REGION          = self.input.region
      EXPECTED_ACCOUNT_ID = self.input.account
    }
  }
  provisioner "local-exec" {
    when    = destroy
    command = "python3 '${self.input.script}' destroy"
    environment = {
      PROJECT_NAME        = self.input.project
      AWS_REGION          = self.input.region
      EXPECTED_ACCOUNT_ID = self.input.account
      CLEANUP_BUCKETS     = self.input.cleanup
    }
  }
}

locals {
  lambda_role_arn    = var.lobby_lambda_role_arn != "" ? var.lobby_lambda_role_arn : (var.bootstrap_from_source ? data.aws_iam_role.lab.arn : "")
  workflow_role_arn  = var.lobby_workflow_role_arn != "" ? var.lobby_workflow_role_arn : (var.bootstrap_from_source ? data.aws_iam_role.lab.arn : "")
  scheduler_role_arn = var.lobby_scheduler_role_arn != "" ? var.lobby_scheduler_role_arn : (var.bootstrap_from_source ? data.aws_iam_role.lab.arn : "")

  world_image   = var.bootstrap_from_source ? data.external.lab_assets[0].result.world_image : var.world_image
  npc_image     = var.bootstrap_from_source ? data.external.lab_assets[0].result.npc_image : var.npc_image
  metrics_image = var.bootstrap_from_source ? data.external.lab_assets[0].result.metrics_image : var.metrics_image
  flink_jar     = var.bootstrap_from_source ? data.external.lab_assets[0].result.flink_jar : var.flink_job_jar_path
  lambda_zips = { for name in ["public", "internal", "lifecycle", "maintenance", "migrate"] : name => (
    var.bootstrap_from_source ? data.external.lab_assets[0].result["lambda_${name}_zip"] : "${var.lobby_lambda_package_dir}/${name}.zip"
  ) }
}

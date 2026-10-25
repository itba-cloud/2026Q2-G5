# Empty, disposable backend test. Contains no application resources or secrets.
terraform {
  required_version = "= 1.16.1"
  backend "s3" {}
}
resource "terraform_data" "probe" {
  input = "state-backend-permission-probe"
}

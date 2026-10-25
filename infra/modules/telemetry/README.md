<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.7.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | ~> 5.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | 5.100.0 |
| <a name="provider_terraform"></a> [terraform](#provider\_terraform) | n/a |

## Modules

No modules.

## Resources

| Name | Type |
|------|------|
| [aws_cloudwatch_log_group.flink](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_cloudwatch_log_stream.flink](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_stream) | resource |
| [aws_dynamodb_table.telemetry](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table) | resource |
| [aws_kinesis_stream.telemetry](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_stream) | resource |
| [aws_kinesisanalyticsv2_application.telemetry](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesisanalyticsv2_application) | resource |
| [aws_s3_object.flink_job_jar](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_object) | resource |
| [terraform_data.lab_stream](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |
| [aws_kinesis_stream.lab](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/kinesis_stream) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_account_id"></a> [account\_id](#input\_account\_id) | Account the stream script must run against; it refuses any other. | `string` | n/a | yes |
| <a name="input_artifacts_bucket"></a> [artifacts\_bucket](#input\_artifacts\_bucket) | Versioned bucket for the Flink job jar. Versioning must be enabled before the upload. | <pre>object({<br/>    id  = string<br/>    arn = string<br/>  })</pre> | n/a | yes |
| <a name="input_create_stream_with_script"></a> [create\_stream\_with\_script](#input\_create\_stream\_with\_script) | Create the Kinesis stream with scripts/lab-stream.py instead of aws\_kinesis\_stream. The Learner Lab denies an API call the provider makes on create. | `bool` | n/a | yes |
| <a name="input_flink_jar_path"></a> [flink\_jar\_path](#input\_flink\_jar\_path) | n/a | `string` | n/a | yes |
| <a name="input_flink_source_hash"></a> [flink\_source\_hash](#input\_flink\_source\_hash) | Immutable build-input fingerprint; null uses the JAR byte hash for manual builds. | `string` | `null` | no |
| <a name="input_name"></a> [name](#input\_name) | Prefix for the stream, table, Flink application and log group (<name>-telemetry...). | `string` | n/a | yes |
| <a name="input_region"></a> [region](#input\_region) | n/a | `string` | n/a | yes |
| <a name="input_service_role_arn"></a> [service\_role\_arn](#input\_service\_role\_arn) | Existing role the Flink application runs with. The Learner Lab does not allow creating roles. | `string` | n/a | yes |
| <a name="input_start_application"></a> [start\_application](#input\_start\_application) | n/a | `bool` | `true` | no |
| <a name="input_stream_script"></a> [stream\_script](#input\_stream\_script) | Path to scripts/lab-stream.py, relative to the Terraform working directory. | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_application_name"></a> [application\_name](#output\_application\_name) | n/a |
| <a name="output_stream_arn"></a> [stream\_arn](#output\_stream\_arn) | n/a |
| <a name="output_stream_created_with_script"></a> [stream\_created\_with\_script](#output\_stream\_created\_with\_script) | Whether the stream comes from lab-stream.py (true) or from aws\_kinesis\_stream (false). |
| <a name="output_stream_name"></a> [stream\_name](#output\_stream\_name) | n/a |
| <a name="output_table_name"></a> [table\_name](#output\_table\_name) | n/a |
<!-- END_TF_DOCS -->
#!/usr/bin/env python3
"""Delete the old S3 secrets bucket, every object version included.

Until task 03 the database and Metrics passwords lived in
<project>-secrets-<account>. The bucket is versioned and was created outside
Terraform, so removing it from the configuration keeps the old passwords in
its versions. Run this once per account, after applying the change that moves
the passwords to Secrets Manager.

    python3 scripts/purge-legacy-secrets.py --project ewo-evaluacion --account 123456789012
    python3 scripts/purge-legacy-secrets.py --project ewo-evaluacion --account 123456789012 --confirm

Without --confirm it only reports what it would delete. It refuses to touch a
bucket in another account or one not tagged as this project's bootstrap
bucket. It prints keys and counts, never object contents.
"""
import argparse
import json
import os
import subprocess
import sys

OWNERS = {"terraform-bootstrap", "bootstrap-buckets.sh"}


def aws(region, *args, check=True):
    result = subprocess.run(["aws", *args, "--region", region, "--output", "json"], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"AWS operation failed: {args[0]} {args[1]}: {result.stderr.strip()}")
    return result


def parse(result):
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--project", required=True)
    parser.add_argument("--account", required=True, help="Expected AWS account id; refuses to run anywhere else.")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--confirm", action="store_true", help="Delete instead of only reporting.")
    args = parser.parse_args()

    account = parse(aws(args.region, "sts", "get-caller-identity"))["Account"]
    if account != args.account:
        sys.exit(f"Credentials belong to account {account}, not {args.account}; refusing to delete.")

    bucket = f"{args.project}-secrets-{account}"
    if aws(args.region, "s3api", "head-bucket", "--bucket", bucket, check=False).returncode:
        print(f"Nothing to purge: {bucket} does not exist.")
        return

    tags = {tag["Key"]: tag["Value"] for tag in parse(aws(args.region, "s3api", "get-bucket-tagging", "--bucket", bucket)).get("TagSet", [])}
    if tags.get("Project") != args.project or tags.get("ManagedBy") not in OWNERS:
        sys.exit(f"{bucket} is not tagged as this project's bootstrap bucket; refusing to delete.")

    # The CLI follows pagination by itself and returns every version.
    listing = parse(aws(args.region, "s3api", "list-object-versions", "--bucket", bucket))
    objects = [{"Key": item["Key"], "VersionId": item["VersionId"]}
               for kind in ("Versions", "DeleteMarkers") for item in listing.get(kind) or []]
    keys = sorted({item["Key"] for item in objects})
    print(f"{bucket}: {len(objects)} object versions and delete markers ({', '.join(keys) or 'none'}).")

    if not args.confirm:
        print("Dry run: nothing deleted. Repeat with --confirm to delete the versions and the bucket.")
        return

    for start in range(0, len(objects), 1000):
        batch = json.dumps({"Objects": objects[start:start + 1000], "Quiet": True})
        errors = parse(aws(args.region, "s3api", "delete-objects", "--bucket", bucket, "--delete", batch)).get("Errors")
        if errors:
            sys.exit(f"Could not delete {len(errors)} versions from {bucket}; the bucket is kept.")
    aws(args.region, "s3api", "delete-bucket", "--bucket", bucket)
    print(f"Deleted {bucket} and its {len(objects)} versions.")


if __name__ == "__main__":
    main()

#!/bin/bash
# Build + push the multi-CLI coding-agent runtime image (ARM64) to ECR.
#
# Account ID, region, and the ECR registry are all derived from credentials via
# config.sh — never hardcoded.
#
# Usage: ./build-and-push.sh [image-tag]   (default tag: latest)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../config.sh"

IMAGE_NAME="coding-agent-runtime"
IMAGE_TAG="${1:-latest}"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
FULL_IMAGE="${ECR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "Building ${FULL_IMAGE} (linux/arm64)..."

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

aws ecr describe-repositories --repository-names "$IMAGE_NAME" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$IMAGE_NAME" --region "$AWS_REGION" >/dev/null

docker build --platform linux/arm64 \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  -t "$FULL_IMAGE" \
  "$SCRIPT_DIR"

docker push "$FULL_IMAGE"

echo ""
echo "OK pushed ${FULL_IMAGE}"
echo "Export for deploy.py:"
echo "  export IMAGE_URI=${FULL_IMAGE}"

#!/bin/bash
set -e

# Configuration
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID to your AWS account number}"
REGION="${AWS_REGION:-us-east-1}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_NAME="runtime-agent"
IMAGE_TAG="${1:-latest}"
FULL_IMAGE_NAME="${ECR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "Building ARM64 container image..."
echo "Image: ${FULL_IMAGE_NAME}"

# Ensure ECR repo exists (idempotent — first-time setup creates it)
if ! aws ecr describe-repositories --repository-names "${IMAGE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Creating ECR repository ${IMAGE_NAME}..."
  aws ecr create-repository \
    --repository-name "${IMAGE_NAME}" \
    --region "${REGION}" \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi

# Ensure we're logged into ECR
echo "Logging into ECR..."
aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}

# Build the image for ARM64 (native on Apple Silicon via Colima)
echo "Building Docker image..."
docker build --platform linux/arm64 -t ${IMAGE_NAME}:${IMAGE_TAG} -t ${FULL_IMAGE_NAME} .

# Push to ECR
echo "Pushing to ECR..."
docker push ${FULL_IMAGE_NAME}

echo "✅ Successfully built and pushed ${FULL_IMAGE_NAME}"

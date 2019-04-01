#!/usr/bin/env bash
. ./.circleci/export-env-vars.sh

docker build -f Dockerfile \
    -t "${IMAGE_NAME}:latest" \
    .

docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:${NODE_ENV}"
docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:${NODE_ENV}-${COMMIT_HASH}"

if [ "$NODE_ENV" = "dev" ];
then
    docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:development"
    docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:test"
fi
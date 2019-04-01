#!/usr/bin/env bash

. ./.circleci/export-env-vars.sh

eval $(aws ecr get-login --no-include-email --region ap-south-1)

docker push "${IMAGE_NAME}:latest"

docker push "${IMAGE_NAME}:${NODE_ENV}"
docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:${NODE_ENV}-${COMMIT_HASH}"

if [ "$NODE_ENV" = "dev" ];
then
    docker push "${IMAGE_NAME}:development"
    docker push "${IMAGE_NAME}:test"
fi
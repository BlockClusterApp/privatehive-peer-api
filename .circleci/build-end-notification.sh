#!/usr/bin/env bash

. ./.circleci/export-env-vars.sh

curl -X POST \
  "${API_HOST}/api/networks/update-container-images" \
  -H "authorization: ${NETWORK_UPDATE_ID}:${NETWORK_UPDATE_KEY}" \
  -H 'cache-control: no-cache' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "container=privatehive-peer&imageTag=${NODE_ENV}-${COMMIT_HASH}"

exit 0;

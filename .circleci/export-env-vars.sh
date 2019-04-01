#!/usr/bin/env bash

export COMMIT_HASH=${CIRCLE_SHA1}

if [ "$CIRCLE_BRANCH" = "master" ] || [ "$CIRCLE_TAG" = "production" ];
then
    export NODE_ENV="production"
elif [ "$CIRCLE_BRANCH" = "staging" ] || [ "$CIRCLE_TAG" = "staging" ];
then 
    export NODE_ENV="staging"
elif [ "$CIRCLE_BRANCH" = "test" ] || [ "$CIRCLE_TAG" = "test" ];
then
    export NODE_ENV="test"
else
    export NODE_ENV="dev"
fi


export IMAGE_NAME='402432300121.dkr.ecr.ap-south-1.amazonaws.com/privatehive-peer-api'

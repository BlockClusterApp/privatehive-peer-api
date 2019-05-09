pipeline {
  agent any
  stages {
    stage('Docker build') {
      steps {
        sh './.circleci/build-start-notification.sh'
        sh './.circleci/docker-build.sh'
      }
    }
    stage('Docker Push') {
      
      steps {
        sh './.circleci/docker-push.sh'
      }
    }
    stage('Notify finish') {
      steps {
        sh './.circleci/build-end-notification.sh'
      }
    }
  }
}

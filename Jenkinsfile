#!/usr/bin/env groovy
@Library("jenkins-devops-scripts@v0.2.2") _

node('slave') {
    def project = "tileserver"
    def stack_utils = new com.beat.utilities.stack()

    // Clone Repo
    stage('Clone repository') {
      checkout scm
    }

    // Build image
    stage('Build docker image') {
        img = docker.build("beat/${project}:latest", "--no-cache .")
    }

    // Push image
    stage('Push image to registry') {
      // If image is built, push it to registry
      // Get Management stack variables
      envVarMapManagement = stack_utils.managementstackVariables()
      docker.withRegistry("https://${envVarMapManagement.REGISTRY_SERVER}") {
          img.push()
        }
    }
}

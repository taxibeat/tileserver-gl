help:
	@echo "Please use 'make <target>' where <target> is one of the following:"
	@echo "  build           to build container."
	@echo "  start           to start container."
	@echo "  stop            to stop container."

build:
	docker-compose build

start:
	docker-compose up

stop:
	docker-compose down

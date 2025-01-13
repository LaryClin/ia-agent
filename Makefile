.PHONY: install start stop clean

install:
	@echo "Installing dependencies..."
	@pnpm install --no-frozen-lockfile
	@pnpm run build
	@docker compose build

start:
	@echo "Starting services..."
	@docker compose up -d

stop:
	@echo "Stopping services..."
	@docker compose down

clean:
	@echo "Cleaning up..."
	@docker compose down -v
	@rm -rf node_modules

all: install start

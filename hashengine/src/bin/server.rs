use actix_web::{web, App, HttpResponse, HttpServer};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use rayon::prelude::*;
use log::{info, error, warn, debug};

// Performance: Use mimalloc as global allocator for better performance
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

// Import HashEngine modules
mod hashengine {
    include!("../hashengine.rs");
}
mod rom {
    include!("../rom.rs");
}

use hashengine::hash as sh_hash;
use rom::{RomGenerationType, Rom};

// Global ROM state using RwLock to allow reinitialization for new challenges
static ROM: once_cell::sync::Lazy<RwLock<Option<Arc<Rom>>>> = once_cell::sync::Lazy::new(|| RwLock::new(None));

#[derive(Debug, Deserialize)]
struct InitRequest {
    no_pre_mine: String,
    #[serde(rename = "ashConfig")]
    ash_config: AshConfig,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AshConfig {
    #[serde(rename = "nbLoops")]
    nb_loops: u32,
    #[serde(rename = "nbInstrs")]
    nb_instrs: u32,
    pre_size: u32,
    rom_size: u32,
    mixing_numbers: u32,
}

#[derive(Debug, Serialize)]
struct InitResponse {
    status: String,
    worker_pid: u32,
    no_pre_mine: String,
}

#[derive(Debug, Deserialize)]
struct HashRequest {
    preimage: String,
}

#[derive(Debug, Serialize)]
struct HashResponse {
    hash: String,
}

#[derive(Debug, Deserialize)]
struct BatchHashRequest {
    preimages: Vec<String>,
}

#[derive(Debug, Serialize)]
struct BatchHashResponse {
    hashes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    #[serde(rename = "romInitialized")]
    rom_initialized: bool,
    #[serde(rename = "nativeAvailable")]
    native_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_pre_mine_first8: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_pre_mine_last8: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

/// POST /init - Initialize ROM with challenge parameters
async fn init_handler(req: web::Json<InitRequest>) -> HttpResponse {
    info!("POST /init request received");
    info!("no_pre_mine: {}...", &req.no_pre_mine[..16.min(req.no_pre_mine.len())]);

    let no_pre_mine_bytes = req.no_pre_mine.as_bytes();

    // Check if ROM already initialized with different no_pre_mine
    {
        let rom_lock = ROM.read().unwrap();
        if rom_lock.is_some() {
            warn!("ROM already initialized, reinitializing for new challenge...");
        }
    }

    info!("Starting ROM initialization (this may take 5-10 seconds)...");
    let start = std::time::Instant::now();

    // Create ROM using TwoStep generation
    let rom = Rom::new(
        no_pre_mine_bytes,
        RomGenerationType::TwoStep {
            pre_size: req.ash_config.pre_size as usize,
            mixing_numbers: req.ash_config.mixing_numbers as usize,
        },
        req.ash_config.rom_size as usize,
    );

    let elapsed = start.elapsed().as_secs_f64();

    // Store ROM in global state (replace if already exists)
    let rom_arc = Arc::new(rom);
    {
        let mut rom_lock = ROM.write().unwrap();
        *rom_lock = Some(rom_arc);
    }

    info!("✓ ROM initialized in {:.1}s", elapsed);

    HttpResponse::Ok().json(InitResponse {
        status: "initialized".to_string(),
        worker_pid: std::process::id(),
        no_pre_mine: format!("{}...", &req.no_pre_mine[..16.min(req.no_pre_mine.len())]),
    })
}

/// POST /hash - Hash single preimage
async fn hash_handler(req: web::Json<HashRequest>) -> HttpResponse {
    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock

    let salt = req.preimage.as_bytes();
    let hash_bytes = sh_hash(salt, &rom, 8, 256);
    let hash_hex = hex::encode(hash_bytes);

    HttpResponse::Ok().json(HashResponse {
        hash: hash_hex,
    })
}

/// POST /hash-batch - Hash multiple preimages in parallel
async fn hash_batch_handler(req: web::Json<BatchHashRequest>) -> HttpResponse {
    let batch_start = std::time::Instant::now();

    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock

    if req.preimages.is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "preimages array is required".to_string(),
        });
    }

    let preimage_count = req.preimages.len();

    // Parallel hash processing using rayon with pre-allocated result vector
    // Each preimage is hashed on a separate thread
    let hash_start = std::time::Instant::now();
    let hashes: Vec<String> = req.preimages
        .par_iter()
        .map(|preimage| {
            let salt = preimage.as_bytes();
            let hash_bytes = sh_hash(salt, &rom, 8, 256);
            hex::encode(hash_bytes)
        })
        .collect();

    let _hash_duration = hash_start.elapsed();
    let total_duration = batch_start.elapsed();
    let throughput = (preimage_count as f64 / total_duration.as_secs_f64()) as u64;

    // Log performance metrics at debug level (only visible with RUST_LOG=debug)
    if preimage_count >= 100 {
        debug!(
            "Batch processed: {} hashes in {:?} ({} H/s)",
            preimage_count, total_duration, throughput
        );
    }

    HttpResponse::Ok().json(BatchHashResponse { hashes })
}

/// POST /hash-batch-shared - Zero-copy batch hashing with SharedArrayBuffer
/// Note: This is a compatibility endpoint - actual shared memory not used in Rust
async fn hash_batch_shared_handler(req: web::Json<serde_json::Value>) -> HttpResponse {
    // Extract preimages from request
    let preimages = match req.get("preimages") {
        Some(serde_json::Value::Array(arr)) => {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<String>>()
        }
        _ => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: "preimages array is required".to_string(),
            });
        }
    };

    let rom_lock = ROM.read().unwrap();
    let rom = match rom_lock.as_ref() {
        Some(r) => Arc::clone(r),
        None => {
            error!("ROM not initialized");
            return HttpResponse::ServiceUnavailable().json(ErrorResponse {
                error: "ROM not initialized. Call /init first.".to_string(),
            });
        }
    };
    drop(rom_lock); // Release read lock

    if preimages.is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "preimages array is required".to_string(),
        });
    }

    let preimage_count = preimages.len();

    // Parallel hash processing with pre-allocation
    let batch_start = std::time::Instant::now();
    let hashes: Vec<String> = preimages
        .par_iter()
        .map(|preimage| {
            let salt = preimage.as_bytes();
            let hash_bytes = sh_hash(salt, &rom, 8, 256);
            hex::encode(hash_bytes)
        })
        .collect();

    let total_duration = batch_start.elapsed();
    let throughput = (preimage_count as f64 / total_duration.as_secs_f64()) as u64;

    // Log performance metrics at debug level (only visible with RUST_LOG=debug)
    if preimage_count >= 100 {
        debug!(
            "Batch shared processed: {} hashes in {:?} ({} H/s)",
            preimage_count, total_duration, throughput
        );
    }

    // Return standard response (SharedArrayBuffer handled on Node.js side)
    HttpResponse::Ok().json(BatchHashResponse { hashes })
}

/// GET /health - Health check endpoint
async fn health_handler() -> HttpResponse {
    let rom_lock = ROM.read().unwrap();
    let rom_initialized = rom_lock.is_some();
    drop(rom_lock);

    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        rom_initialized,
        native_available: true,
        config: None,
        no_pre_mine_first8: None,
        no_pre_mine_last8: None,
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "9001".to_string());

    // Get system CPU information
    let physical_cores = num_cpus::get_physical();

    // HTTP workers: configurable via WORKERS env var (default 16 for good concurrency)
    let workers = std::env::var("WORKERS")
            .unwrap_or_else(|_| num_cpus::get().to_string())
            .parse::<usize>()
            .unwrap_or(num_cpus::get());

    // Rayon threads: use physical cores (avoids hyperthreading overhead for CPU-intensive work)
    // rayon::ThreadPoolBuilder::new()
    //     .num_threads(physical_cores)
    //     .build_global()
    //     .ok();

    info!("═══════════════════════════════════════════════════════════");
    info!("HashEngine Native Hash Service (Rust)");
    info!("═══════════════════════════════════════════════════════════");
    info!("Listening: {}:{}", host, port);
    info!("HTTP Workers: {} (actix-web server threads)", workers);
    info!("Rayon Threads: {} (physical cores for hashing)", physical_cores);
    info!("═══════════════════════════════════════════════════════════");

    HttpServer::new(|| {
        App::new()
            // Logger middleware removed - only log important events via RUST_LOG
            .route("/init", web::post().to(init_handler))
            .route("/hash", web::post().to(hash_handler))
            .route("/hash-batch", web::post().to(hash_batch_handler))
            .route("/hash-batch-shared", web::post().to(hash_batch_shared_handler))
            .route("/health", web::get().to(health_handler))
    })
    .workers(workers)
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}

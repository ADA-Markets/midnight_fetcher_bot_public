use actix_web::{web, App, HttpResponse, HttpServer, middleware};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock, atomic::{AtomicU64, AtomicBool, Ordering}};
use rayon::prelude::*;
use log::{info, error, warn, debug};
use std::time::{Instant, Duration};

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
mod preimage {
    include!("../preimage.rs");
}
mod validation {
    include!("../validation.rs");
}

use hashengine::hash as sh_hash;
use rom::{RomGenerationType, Rom};
use preimage::{ChallengeData, build_preimage};
use validation::matches_difficulty;

// Global ROM state using RwLock to allow reinitialization for new challenges
static ROM: once_cell::sync::Lazy<RwLock<Option<Arc<Rom>>>> = once_cell::sync::Lazy::new(|| RwLock::new(None));

// Global mining statistics
static TOTAL_HASHES: AtomicU64 = AtomicU64::new(0);
static SOLUTIONS_FOUND: AtomicU64 = AtomicU64::new(0);
static MINING_ACTIVE: AtomicBool = AtomicBool::new(false);
static STATS_START_TIME: once_cell::sync::Lazy<RwLock<Option<Instant>>> = once_cell::sync::Lazy::new(|| RwLock::new(None));
static LAST_RESET_TIME: once_cell::sync::Lazy<RwLock<Option<Instant>>> = once_cell::sync::Lazy::new(|| RwLock::new(None));

// CPU usage mode - default to "normal" for better user experience
static CPU_MODE: once_cell::sync::Lazy<RwLock<String>> = once_cell::sync::Lazy::new(|| RwLock::new("normal".to_string()));

#[derive(Debug, Deserialize)]
struct InitRequest {
    no_pre_mine: String,
    #[serde(rename = "ashConfig")]
    ash_config: AshConfig,
}

#[derive(Debug, Deserialize)]
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

// === NEW: Autonomous Mining Structures ===

#[derive(Debug, Deserialize)]
struct MineRequest {
    worker_id: u64,
    address: String,
    challenge: ChallengeData,
    batch_size: usize,
    nonce_start: String, // String to support large numbers from TypeScript
}

#[derive(Debug, Serialize)]
struct MineResponse {
    solutions: Vec<Solution>,
    hashes_computed: usize,
}

#[derive(Debug, Serialize)]
struct Solution {
    nonce: String,
    hash: String,
    preimage: String,
}

// === NEW: Continuous Mining Structures ===

#[derive(Debug, Deserialize)]
struct StartMiningRequest {
    worker_id: u64,
    address: String,
    challenge: ChallengeData,
}

#[derive(Debug, Serialize)]
struct MiningStatsResponse {
    total_hashes: u64,
    solutions_found: u64,
    hash_rate: u64,  // Hashes per second
    uptime_seconds: u64,
    mining_active: bool,
    cpu_mode: String,  // "max" or "normal"
}

#[derive(Debug, Deserialize)]
struct SetCpuModeRequest {
    mode: String,  // "max" or "normal"
}

#[derive(Debug, Serialize)]
struct CpuModeResponse {
    mode: String,
    thread_count: usize,
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

    let hash_duration = hash_start.elapsed();
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

/// GET /stats - Get mining statistics and hash rate
async fn stats_handler() -> HttpResponse {
    // Check if we need to reset hourly counters (prevent overflow)
    {
        let mut reset_lock = LAST_RESET_TIME.write().unwrap();
        let now = Instant::now();

        let should_reset = if let Some(last_reset) = *reset_lock {
            // Reset every hour
            last_reset.elapsed() >= Duration::from_secs(3600)
        } else {
            // First time - initialize
            true
        };

        if should_reset {
            info!("Resetting hourly hash counter (prevents overflow)");
            TOTAL_HASHES.store(0, Ordering::Relaxed);
            *reset_lock = Some(now);
            // Reset stats to get correct H/s
            {
                let mut stats_lock = STATS_START_TIME.write().unwrap();
                *stats_lock = Some(Instant::now());
            }
        }
    }

    let total_hashes = TOTAL_HASHES.load(Ordering::Relaxed);
    let solutions_found = SOLUTIONS_FOUND.load(Ordering::Relaxed);
    let mining_active = MINING_ACTIVE.load(Ordering::Relaxed);

    let stats_lock = STATS_START_TIME.read().unwrap();
    let (hash_rate, uptime_seconds) = if let Some(start_time) = *stats_lock {
        let elapsed = start_time.elapsed().as_secs();
        let rate = if elapsed > 0 {
            total_hashes / elapsed
        } else {
            0
        };
        (rate, elapsed)
    } else {
        (0, 0)
    };
    drop(stats_lock);

    let cpu_mode = CPU_MODE.read().unwrap().clone();

    HttpResponse::Ok().json(MiningStatsResponse {
        total_hashes,
        solutions_found,
        hash_rate,
        uptime_seconds,
        mining_active,
        cpu_mode,
    })
}

/// POST /set-cpu-mode - Set CPU usage mode (max or normal)
async fn set_cpu_mode_handler(req: web::Json<SetCpuModeRequest>) -> HttpResponse {
    let mode = req.mode.to_lowercase();

    if mode != "max" && mode != "normal" {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "Invalid mode. Must be 'max' or 'normal'".to_string(),
        });
    }

    // Update global CPU mode
    let mut cpu_mode_lock = CPU_MODE.write().unwrap();
    *cpu_mode_lock = mode.clone();
    drop(cpu_mode_lock);

    // Configure Rayon thread pool
    let num_cpus = num_cpus::get();
    let thread_count = if mode == "max" {
        // Max mode: use 90% of cores (leaves headroom for OS/other processes)
        std::cmp::max(1, (num_cpus * 9) / 10)
    } else {
        // Normal mode: use 50% of cores (minimum 1)
        std::cmp::max(1, num_cpus / 2)
    };

    // Reinitialize Rayon with new thread count
    rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .build_global()
        .ok(); // Ignore error if already initialized

    info!("CPU mode set to '{}' ({} threads)", mode, thread_count);

    HttpResponse::Ok().json(CpuModeResponse {
        mode,
        thread_count,
    })
}

/// POST /start-mining - Start continuous mining (long-running endpoint)
/// This endpoint mines continuously until a solution is found or an error occurs
async fn start_mining_handler(req: web::Json<StartMiningRequest>) -> HttpResponse {
    info!("POST /start-mining: Worker {} starting for address {}", req.worker_id, req.address);

    // Get ROM
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
    drop(rom_lock);

    // Initialize stats if this is the first mining request
    {
        let mut stats_lock = STATS_START_TIME.write().unwrap();
        if stats_lock.is_none() {
            *stats_lock = Some(Instant::now());
        }
    }

    MINING_ACTIVE.store(true, Ordering::Relaxed);

    let start_time = Instant::now();
    let mut nonce_counter: u64 = (req.worker_id * 1_000_000_000); // Worker-specific nonce range
    const BATCH_SIZE: usize = 10000; // Optimized batch size (4 workers × 10K = 40K total parallel hashing)

    loop {
        // Generate batch of nonces and preimages
        let batch_data: Vec<(String, String)> = (0..BATCH_SIZE)
            .map(|i| {
                let nonce_num = nonce_counter + i as u64;
                let nonce_hex = format!("{:016x}", nonce_num);
                let preimage = build_preimage(&nonce_hex, &req.address, &req.challenge);
                (nonce_hex, preimage)
            })
            .collect();

        nonce_counter += BATCH_SIZE as u64;

        // Parallel hash computation with inline validation
        let found_solution: Option<Solution> = batch_data
            .par_iter()
            .find_map_any(|(nonce, preimage)| {
                let salt = preimage.as_bytes();
                let hash_bytes = sh_hash(salt, &rom, 8, 256);
                let hash_hex = hex::encode(hash_bytes);

                // Inline difficulty check (dual validation)
                match matches_difficulty(&hash_hex, &req.challenge.difficulty) {
                    Ok(true) => {
                        info!(
                            "Worker {} found solution! Nonce: {}, Hash: {}...",
                            req.worker_id,
                            nonce,
                            &hash_hex[..16]
                        );
                        Some(Solution {
                            nonce: nonce.clone(),
                            hash: hash_hex,
                            preimage: preimage.clone(),
                        })
                    }
                    Ok(false) => None,
                    Err(e) => {
                        warn!("Validation error for nonce {}: {}", nonce, e);
                        None
                    }
                }
            });

        // Update global stats
        TOTAL_HASHES.fetch_add(BATCH_SIZE as u64, Ordering::Relaxed);

        // If solution found, return it
        if let Some(solution) = found_solution {
            SOLUTIONS_FOUND.fetch_add(1, Ordering::Relaxed);

            let elapsed = start_time.elapsed();
            let hash_rate = (nonce_counter as f64 / elapsed.as_secs_f64()) as u64;

            info!(
                "Worker {}: Found solution after {} hashes in {:.2}s ({} H/s)",
                req.worker_id,
                nonce_counter,
                elapsed.as_secs_f64(),
                hash_rate
            );

            return HttpResponse::Ok().json(MineResponse {
                solutions: vec![solution],
                hashes_computed: nonce_counter as usize,
            });
        }

        // Log progress every million hashes
        if nonce_counter % 1_000_000 == 0 {
            let elapsed = start_time.elapsed();
            let hash_rate = (nonce_counter as f64 / elapsed.as_secs_f64()) as u64;
            debug!(
                "Worker {}: {} hashes in {:.2}s ({} H/s)",
                req.worker_id,
                nonce_counter,
                elapsed.as_secs_f64(),
                hash_rate
            );
        }
    }
}

/// POST /mine - Autonomous mining endpoint
/// Generates preimages internally, hashes them, validates difficulty, and returns only solutions
async fn mine_handler(req: web::Json<MineRequest>) -> HttpResponse {
    let start_time = std::time::Instant::now();

    // Get ROM
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
    drop(rom_lock);

    // Parse starting nonce from string
    let nonce_start = match req.nonce_start.parse::<u64>() {
        Ok(n) => n,
        Err(e) => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: format!("Invalid nonce_start: {}", e),
            });
        }
    };

    // Generate batch of nonces and preimages
    let batch_data: Vec<(String, String)> = (0..req.batch_size)
        .map(|i| {
            let nonce_num = nonce_start + i as u64;
            let nonce_hex = format!("{:016x}", nonce_num);
            let preimage = build_preimage(&nonce_hex, &req.address, &req.challenge);
            (nonce_hex, preimage)
        })
        .collect();

    // Parallel hash computation with inline validation
    let found_solutions: Vec<Solution> = batch_data
        .par_iter()
        .filter_map(|(nonce, preimage)| {
            let salt = preimage.as_bytes();
            let hash_bytes = sh_hash(salt, &rom, 8, 256);
            let hash_hex = hex::encode(hash_bytes);

            // Inline difficulty check (dual validation)
            match matches_difficulty(&hash_hex, &req.challenge.difficulty) {
                Ok(true) => {
                    info!(
                        "Worker {} found solution! Nonce: {}, Hash: {}...",
                        req.worker_id,
                        nonce,
                        &hash_hex[..16]
                    );
                    Some(Solution {
                        nonce: nonce.clone(),
                        hash: hash_hex,
                        preimage: preimage.clone(),
                    })
                }
                Ok(false) => None,
                Err(e) => {
                    warn!("Validation error for nonce {}: {}", nonce, e);
                    None
                }
            }
        })
        .collect();

    let elapsed = start_time.elapsed();
    let hash_rate = (req.batch_size as f64 / elapsed.as_secs_f64()) as u64;

    // Log performance (only when solutions found or at debug level)
    if !found_solutions.is_empty() {
        info!(
            "Worker {}: {} hashes in {:.2}ms ({} H/s) - {} solutions found",
            req.worker_id,
            req.batch_size,
            elapsed.as_secs_f64() * 1000.0,
            hash_rate,
            found_solutions.len()
        );
    } else {
        debug!(
            "Worker {}: {} hashes in {:.2}ms ({} H/s) - no solutions",
            req.worker_id,
            req.batch_size,
            elapsed.as_secs_f64() * 1000.0,
            hash_rate
        );
    }

    HttpResponse::Ok().json(MineResponse {
        solutions: found_solutions,
        hashes_computed: req.batch_size,
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "9001".to_string());
    let workers = std::env::var("WORKERS")
        .unwrap_or_else(|_| num_cpus::get().to_string())
        .parse::<usize>()
        .unwrap_or(num_cpus::get());

    // Read CPU percentage from config file
    let config_path = std::path::Path::new("hash-config.json");
    let cpu_percentage = if config_path.exists() {
        match std::fs::read_to_string(config_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(config) => {
                        config["cpu_percentage"].as_u64().unwrap_or(90) as usize
                    }
                    Err(_) => {
                        warn!("Failed to parse hash-config.json, using default 90%");
                        90
                    }
                }
            }
            Err(_) => {
                warn!("Failed to read hash-config.json, using default 90%");
                90
            }
        }
    } else {
        info!("hash-config.json not found, using default 90%");
        90
    };

    // Initialize Rayon thread pool based on config percentage
    let num_cpus = num_cpus::get();
    let thread_count = std::cmp::max(1, (num_cpus * cpu_percentage) / 100);
    rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .build_global()
        .ok();

    info!("═══════════════════════════════════════════════════════════");
    info!("HashEngine Native Hash Service (Rust)");
    info!("═══════════════════════════════════════════════════════════");
    info!("Listening: {}:{}", host, port);
    info!("HTTP Workers: {} (actix-web server threads)", workers);
    info!("Mining Threads: {} ({}% of {} cores)", thread_count, cpu_percentage, num_cpus);
    info!("Config: hash-config.json (edit cpu_percentage to change)");
    info!("═══════════════════════════════════════════════════════════");

    HttpServer::new(|| {
        App::new()
            // Logger middleware removed - only log important events via RUST_LOG
            .route("/init", web::post().to(init_handler))
            .route("/hash", web::post().to(hash_handler))
            .route("/hash-batch", web::post().to(hash_batch_handler))
            .route("/hash-batch-shared", web::post().to(hash_batch_shared_handler))
            .route("/mine", web::post().to(mine_handler))
            .route("/start-mining", web::post().to(start_mining_handler))
            .route("/stats", web::get().to(stats_handler))
            .route("/set-cpu-mode", web::post().to(set_cpu_mode_handler))
            .route("/health", web::get().to(health_handler))
    })
    .workers(workers)
    .keep_alive(Duration::from_secs(3600 * 24)) // 24 hour keep-alive for long-running mining requests
    .client_request_timeout(Duration::from_secs(3600 * 24)) // 24 hour timeout
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}

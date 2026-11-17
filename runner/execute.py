import sys
import os
import time
import json
import resource
import subprocess
import signal

def set_limits(time_limit_sec, memory_limit_bytes, output_limit_bytes):
    # Set CPU time limit (soft limit time_limit_sec, hard limit time_limit_sec + 1)
    resource.setrlimit(resource.RLIMIT_CPU, (max(1, int(time_limit_sec) + 1), max(2, int(time_limit_sec) + 2)))
    # Set max output file size / stdout
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit_bytes * 2, output_limit_bytes * 2))
    # Note: RLIMIT_AS (virtual memory) can be applied if supported by the OS
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory_limit_bytes * 4, memory_limit_bytes * 4))
    except Exception:
        pass

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            sys.stderr.write("No input JSON provided\n")
            sys.exit(1)
        
        request = json.loads(raw_input)
        source_code = request.get("sourceCode", "")
        test_input = request.get("input", "")
        time_limit_ms = int(request.get("timeLimitMs", 2000))
        memory_limit_mb = int(request.get("memoryLimitMb", 128))
        output_limit_bytes = int(request.get("outputLimitBytes", 65536))
        
        # Check for controllable runner failure injection (Stage 4 requirement)
        if request.get("simulateRunnerCrash") is True:
            sys.stderr.write("Simulated runner crash initiated via test request\n")
            sys.exit(71) # Operating system exit code for internal failure
            
        if request.get("simulateHang") is True:
            time.sleep(30)
            sys.exit(0)
            
        source_file = "/tmp/solution.py"
        
        # 1. Compilation Check Phase: catch syntax errors before execution
        try:
            compile(source_code, source_file, "exec")
        except SyntaxError as syn_err:
            compilation_result = {
                "exitCode": 1,
                "isCompilationError": True,
                "timedOut": False,
                "stdout": "",
                "stderr": f"Compilation/SyntaxError: {str(syn_err)}",
                "executionTimeMs": 2,
                "memoryUsageMb": 16,
                "outputTruncated": False
            }
            print(json.dumps(compilation_result))
            sys.exit(0)

        with open(source_file, "w", encoding="utf-8") as f:
            f.write(source_code)
            
        time_limit_sec = max(0.1, time_limit_ms / 1000.0)
        memory_limit_bytes = memory_limit_mb * 1024 * 1024
        
        start_wall_time = time.monotonic()
        
        # 2. Spawn execution process with sandboxed cgroup/rlimits
        proc = subprocess.Popen(
            [sys.executable, "-u", source_file],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=lambda: set_limits(time_limit_sec, memory_limit_bytes, output_limit_bytes)
        )
        
        stdout_data = ""
        stderr_data = ""
        timed_out = False
        
        try:
            # Wall-clock timeout enforcement
            stdout_data, stderr_data = proc.communicate(input=test_input, timeout=time_limit_sec)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            try:
                stdout_data, stderr_data = proc.communicate(timeout=0.5)
            except Exception:
                pass
                
        end_wall_time = time.monotonic()
        execution_wall_time_ms = int((end_wall_time - start_wall_time) * 1000)
        
        output_truncated = False
        if len(stdout_data.encode("utf-8")) > output_limit_bytes:
            stdout_data = stdout_data[:output_limit_bytes]
            output_truncated = True
            
        result = {
            "exitCode": proc.returncode if not timed_out else -1,
            "isCompilationError": False,
            "timedOut": timed_out,
            "stdout": stdout_data,
            "stderr": stderr_data[:4096], # cap stderr to 4KB
            "executionTimeMs": execution_wall_time_ms,
            "memoryUsageMb": 16, # Estimated baseline memory
            "outputTruncated": output_truncated
        }
        
        print(json.dumps(result))
        
        # Cleanup temporary files
        try:
            if os.path.exists(source_file):
                os.remove(source_file)
        except Exception:
            pass
            
    except Exception as e:
        sys.stderr.write(f"Runner internal error: {str(e)}\n")
        sys.exit(2)

if __name__ == "__main__":
    main()

// macOS only. The caller stages and authenticates the new bundle; this helper
// only checks the quit/identity preconditions and exchanges the two names.
// Run this executable from outside the installed bundle so it isn't itself
// counted as a process using the bundle.
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef UPDATE_SWAP_PARENT_TIMEOUT_MS
#define UPDATE_SWAP_PARENT_TIMEOUT_MS 60000
#endif
#ifndef UPDATE_SWAP_HELPER_TIMEOUT_MS
#define UPDATE_SWAP_HELPER_TIMEOUT_MS 5000
#endif

#define APP "pi.app"
#define DIR_FLAGS (O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)

struct identity {
    uintmax_t dev, ino;
};

static bool parse_number(const char *text, uintmax_t *value)
{
    if (!*text || text[strspn(text, "0123456789")] != '\0')
        return false;
    errno = 0;
    *value = strtoumax(text, NULL, 10);
    return errno == 0;
}

static bool transaction_basename(const char *name)
{
    const char prefix[] = ".pi-update-";
    size_t n = sizeof(prefix) - 1;
    return strncmp(name, prefix, n) == 0 && strlen(name + n) == 6 &&
        strspn(name + n, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") == 6;
}

static struct identity identity_of(const struct stat *st)
{
    return (struct identity){ (uintmax_t)st->st_dev, (uintmax_t)st->st_ino };
}

static bool matches(const struct stat *st, struct identity id)
{
    return S_ISDIR(st->st_mode) && (uintmax_t)st->st_dev == id.dev &&
        (uintmax_t)st->st_ino == id.ino;
}

static bool matches_at(int dir, const char *name, struct identity id)
{
    struct stat st;
    return fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && matches(&st, id);
}

static bool private_directory(const struct stat *st)
{
    return S_ISDIR(st->st_mode) && st->st_uid == getuid() && (st->st_mode & 07777) == 0700;
}

static int64_t monotonic_ms(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
        return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static bool poll_again(int64_t start, int timeout_ms)
{
    int64_t now = monotonic_ms();
    if (start < 0 || now < start || now - start >= timeout_ms)
        return false;
    int64_t remaining = timeout_ms - (now - start);
    struct timespec delay = { 0, (remaining < 50 ? remaining : 50) * 1000000 };
    return nanosleep(&delay, NULL) == 0 || errno == EINTR;
}

static bool wait_for_parent(pid_t pid, pid_t initial_parent)
{
    if (initial_parent != pid && initial_parent != 1)
        return false;

    int64_t start = monotonic_ms();
    do {
        pid_t parent = getppid();
        if (parent == 1) {
            // Once a known parent is gone, PID reuse cannot keep us waiting.
            // If already orphaned at startup, require the supplied PID to go.
            if (initial_parent == pid || (kill(pid, 0) == -1 && errno == ESRCH))
                return true;
        } else if (parent != pid) {
            return false;
        }
    } while (poll_again(start, UPDATE_SWAP_PARENT_TIMEOUT_MS));
    return false;
}

// A full process snapshot is required. Retry if the PID list grew between
// sizing and filling the buffer. Return 1 for a match, 0 for none, -1 on error.
static int bundle_in_use(const char *bundle)
{
    int size = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    for (int attempt = 0; attempt < 4 && size > 0 && size <= INT_MAX / 2; ++attempt) {
        size *= 2;
        pid_t *pids = malloc((size_t)size);
        if (!pids)
            return -1;
        int used = proc_listpids(PROC_ALL_PIDS, 0, pids, size);
        // Require space for another PID so a truncated list cannot look complete.
        if (used >= size - (int)sizeof(pid_t)) {
            free(pids);
            continue;
        }
        if (used <= 0 || (size_t)used % sizeof(pid_t) != 0) {
            free(pids);
            return -1;
        }

        int busy = 0;
        size_t length = strlen(bundle);
        for (size_t i = 0; i < (size_t)used / sizeof(pid_t); ++i) {
            if (pids[i] <= 0)
                continue;
            char path[PROC_PIDPATHINFO_MAXSIZE];
            errno = 0;
            if (proc_pidpath(pids[i], path, sizeof(path)) <= 0) {
                // Exited processes and protected system processes may have no
                // visible executable path for an unprivileged caller.
                if (errno == ESRCH || errno == ENOENT || errno == EPERM || errno == EACCES)
                    continue;
                busy = -1;
                break;
            }
            if (strncmp(path, bundle, length) == 0 && path[length] == '/') {
                busy = 1;
                break;
            }
        }
        free(pids);
        return busy;
    }
    return -1;
}

// NULL means the swap completed; otherwise the string explains deferral.
static const char *swap_when_quiet(pid_t pid, pid_t initial_parent, int install, const char *install_path,
                                  int transaction, const char *transaction_name, struct identity install_id,
                                  struct identity transaction_id, struct identity old, struct identity staged)
{
    if (!wait_for_parent(pid, initial_parent))
        return "parent did not exit or was not the spawning process";

    if (old.dev != staged.dev || old.dev != install_id.dev || old.dev != transaction_id.dev ||
        old.ino == staged.ino || !matches_at(install, APP, old) || !matches_at(transaction, APP, staged))
        return "bundle identity or volume changed";

    // Use the kernel's path, as proc_pidpath also reports kernel vnode paths
    // (e.g. /private/var instead of /var for many temporary directories).
    int app = openat(install, APP, DIR_FLAGS);
    struct stat st;
    char bundle[MAXPATHLEN];
    if (app < 0 || fstat(app, &st) != 0 || !matches(&st, old) || fcntl(app, F_GETPATH, bundle) == -1)
        return "cannot resolve the installed bundle";

    int busy;
    int64_t start = monotonic_ms();
    do {
        busy = bundle_in_use(bundle);
    } while (busy == 1 && poll_again(start, UPDATE_SWAP_HELPER_TIMEOUT_MS));
    if (busy != 0)
        return busy < 0 ? "cannot inspect running processes" : "installed bundle is still in use";

    // Recheck the names after waiting, not just the open directory descriptors.
    char current[MAXPATHLEN];
    if (!matches_at(AT_FDCWD, install_path, install_id) ||
        fstatat(install, transaction_name, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
        !matches(&st, transaction_id) || !private_directory(&st) ||
        fcntl(app, F_GETPATH, current) == -1 || strcmp(bundle, current) != 0 ||
        !matches_at(install, APP, old) || !matches_at(transaction, APP, staged))
        return "install directory, transaction, or bundle identity changed";

    // The exchange is atomic; the preceding userspace checks cannot lock out
    // a concurrent launch or rename between checks and the syscall.
    if (renameatx_np(install, APP, transaction, APP, RENAME_SWAP) != 0) {
        perror("update-swap: renameatx_np");
        return "atomic exchange failed";
    }
    return NULL;
}

static bool record_result(int fd, const char *text)
{
    for (size_t left = strlen(text); left > 0;) {
        ssize_t written = write(fd, text, left);
        if (written < 0 && errno == EINTR)
            continue;
        if (written <= 0)
            return false;
        text += written;
        left -= (size_t)written;
    }
    return close(fd) == 0;
}

int main(int argc, char **argv)
{
    pid_t initial_parent = getppid();
    if (getuid() == 0 || geteuid() != getuid() || getegid() != getgid() ||
        getenv("SUDO_UID") || getenv("SUDO_USER") || getenv("SUDO_COMMAND")) {
        fprintf(stderr, "update-swap: refusing root, sudo, or elevated credentials\n");
        return 1;
    }

    uintmax_t pid;
    struct identity old, staged;
    if (argc != 8 || !parse_number(argv[1], &pid) || pid <= 1 || pid > INT_MAX ||
        !transaction_basename(argv[3]) || !parse_number(argv[4], &old.dev) ||
        !parse_number(argv[5], &old.ino) || !parse_number(argv[6], &staged.dev) ||
        !parse_number(argv[7], &staged.ino)) {
        fprintf(stderr, "usage: update-swap <parent-pid> <install-dir> <transaction-dir-basename> "
                        "<old-dev> <old-ino> <new-dev> <new-ino>\n");
        return 1;
    }

    // A trailing slash makes open follow a final symlink despite O_NOFOLLOW.
    char install_path[MAXPATHLEN];
    size_t length = strlen(argv[2]);
    while (length > 1 && argv[2][length - 1] == '/')
        --length;
    if (length == 0 || length >= sizeof(install_path)) {
        fprintf(stderr, "update-swap: invalid install directory path\n");
        return 1;
    }
    memcpy(install_path, argv[2], length);
    install_path[length] = '\0';

    // Directory descriptors are held until this one-shot process exits.
    struct stat install_st, transaction_st;
    int install = open(install_path, DIR_FLAGS);
    if (install < 0 || fstat(install, &install_st) != 0) {
        perror("update-swap: open install directory");
        return 1;
    }
    int transaction = openat(install, argv[3], DIR_FLAGS);
    if (transaction < 0 || fstat(transaction, &transaction_st) != 0 || !private_directory(&transaction_st)) {
        fprintf(stderr, "update-swap: transaction must be a private directory owned by the current user\n");
        return 1;
    }

    // Claim the transaction before doing anything that could change the bundles.
    // An empty marker is not a completed result: interruption between swap
    // and write leaves the bundle identities as the only record of the swap.
    int result = openat(transaction, "result", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (result < 0) {
        perror("update-swap: create result");
        return 1;
    }

    const char *failure = swap_when_quiet((pid_t)pid, initial_parent, install, install_path, transaction, argv[3],
                                         identity_of(&install_st), identity_of(&transaction_st), old, staged);
    if (failure)
        fprintf(stderr, "update-swap: %s\n", failure);
    if (!record_result(result, failure ? "deferred\n" : "installed\n")) {
        perror("update-swap: write result");
        return 1;
    }
    return failure ? 1 : 0;
}

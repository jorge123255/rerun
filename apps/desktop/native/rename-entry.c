#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/file.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <time.h>
#ifdef __APPLE__
#include <copyfile.h>
#include <sys/acl.h>
#include <sys/xattr.h>
#include <strings.h>
#endif
#ifdef __linux__
#include <sys/syscall.h>
#include <linux/fs.h>
#endif

/* One confined rename, never a replacement. The app supplies a canonical parent and the
 * identities it opened; neither a shell nor paths from the provider are involved. */
static const char *error_name(int error) {
    switch (error) {
        case EEXIST: return "EEXIST";
        case ENOENT: return "ENOENT";
        case ENOTDIR: return "ENOTDIR";
        case ELOOP: return "ELOOP";
        case ESTALE: return "ESTALE";
        case EINVAL: return "EINVAL";
        case EACCES: return "EACCES";
        case EPERM: return "EPERM";
        case EXDEV: return "EXDEV";
        case ENOSYS: return "ENOTSUP";
        case ENOTSUP: return "ENOTSUP";
        default: return "EIO";
    }
}
static int failure(int error) {
    printf("{\"ok\":false,\"code\":\"%s\"}\n", error_name(error));
    return 1;
}
static int number(const char *text, uintmax_t *out) {
    if (!*text || strlen(text) > 24) return 0;
    for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return 0;
    errno = 0;
    char *end;
    *out = strtoumax(text, &end, 10);
    return !errno && !*end;
}
static int name_ok(const char *name) {
    return *name && strlen(name) <= NAME_MAX && strcmp(name, ".") && strcmp(name, "..") && !strchr(name, '/') && !strchr(name, '\\');
}
static int is_identity(const struct stat *info, uintmax_t dev, uintmax_t ino) {
    return (uintmax_t)info->st_dev == dev && (uintmax_t)info->st_ino == ino;
}
static int owner_matches(int fd, const char *path, uintmax_t dev, uintmax_t ino) {
    struct stat opened, listed;
    char canonical[PATH_MAX];
    return !fstat(fd, &opened) && !lstat(path, &listed) && S_ISDIR(listed.st_mode) &&
        is_identity(&opened, dev, ino) && is_identity(&listed, dev, ino) &&
        realpath(path, canonical) && !strcmp(path, canonical);
}
static int exclusive_rename(int fd, const char *from, const char *to) {
#ifdef __APPLE__
    return renameatx_np(fd, from, fd, to, RENAME_EXCL | RENAME_NOFOLLOW_ANY);
#elif defined(__linux__)
    return (int)syscall(SYS_renameat2, fd, from, fd, to, RENAME_NOREPLACE);
#else
    errno = ENOTSUP;
    return -1;
#endif
}
/* A kernel lease on the validated directory inode, shared by UI and engine publishers.
 * The marker is diagnostic only: replacing it cannot split callers across lock inodes. */
static int skill_lock(const char *path, uintmax_t dev, uintmax_t ino) {
    int flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
#ifdef __APPLE__
    flags |= O_NOFOLLOW_ANY;
#else
    flags |= O_NOFOLLOW;
#endif
    int parent = open(path, flags);
    if (parent < 0) return failure(errno);
    if (!owner_matches(parent, path, dev, ino)) { close(parent); return failure(ESTALE); }
    int lock = openat(parent, ".rerun-skill-lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
    if (lock < 0) { int error = errno; close(parent); return failure(error); }
    struct stat opened, listed;
    if (fstat(lock, &opened) || !S_ISREG(opened.st_mode) || opened.st_uid != getuid() || opened.st_nlink != 1 ||
        fstatat(parent, ".rerun-skill-lock", &listed, AT_SYMLINK_NOFOLLOW) || !is_identity(&listed, opened.st_dev, opened.st_ino)) {
        close(lock); close(parent); return failure(ESTALE);
    }
    const pid_t owner = getppid();
    int acquired = 0;
    for (int attempts = 0; attempts < 80; attempts++) {
        if (!flock(parent, LOCK_EX | LOCK_NB)) { acquired = 1; break; }
        if (errno != EWOULDBLOCK && errno != EAGAIN) { int error = errno; close(lock); close(parent); return failure(error); }
        struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
        if (getppid() != owner || poll(&input, 1, 100) != 0) { close(lock); close(parent); return failure(EACCES); }
    }
    if (!acquired) { close(lock); close(parent); return failure(EACCES); }
    if (!owner_matches(parent, path, dev, ino) || fstatat(parent, ".rerun-skill-lock", &listed, AT_SYMLINK_NOFOLLOW) ||
        !is_identity(&listed, opened.st_dev, opened.st_ino) || listed.st_uid != getuid() || listed.st_nlink != 1) {
        close(lock); close(parent); return failure(ESTALE);
    }
    printf("{\"ok\":true,\"dev\":\"%ju\",\"ino\":\"%ju\"}\n", (uintmax_t)opened.st_dev, (uintmax_t)opened.st_ino);
    if (fflush(stdout)) { close(lock); close(parent); return 1; }
    /* No lease expiry while a write is active. EOF or actual parent death releases flock;
     * the supervising Node process bounds acquisition and keeps this stdin pipe private. */
    for (;;) {
        struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
        int ready = poll(&input, 1, 100);
        if (getppid() != owner || ready > 0) break;
        if (ready < 0 && errno != EINTR) break;
    }
    close(lock); close(parent);
    return 0;
}
/* Deterministic race witnesses exist only in the separately compiled test binary. */
#ifdef RERUN_RENAME_TESTING
static void test_barrier(const char *phase) {
    if (!getenv("RERUN_RENAME_TEST_BARRIERS")) return;
    fprintf(stderr, "%s\n", phase);
    fflush(stderr);
    (void)getchar();
}
#else
#define test_barrier(phase) ((void)0)
#endif

static int replacement_failure(int error, int before_swap) {
    printf("{\"ok\":false,\"code\":\"%s\",\"beforeSwap\":%s}\n", error_name(error), before_swap ? "true" : "false");
    return 1;
}

#ifdef __APPLE__
static int shared_regular(const struct stat *info) {
    return S_ISREG(info->st_mode) && info->st_uid == getuid() && info->st_nlink == 1;
}

static int attributes_match(int from, int to) {
    char names[65536];
    const ssize_t length = flistxattr(from, names, sizeof(names), 0);
    if (length < 0 || (to >= 0 && flistxattr(to, NULL, 0, 0) != length)) return 0;
    ssize_t total = 0;
    for (ssize_t offset = 0; offset < length;) {
        const char *name = names + offset;
        const size_t size = strnlen(name, (size_t)(length - offset));
        if (!size || size >= (size_t)(length - offset)) return 0;
        offset += (ssize_t)size + 1;
        const ssize_t bytes = fgetxattr(from, name, NULL, 0, 0, 0);
        if (bytes < 0 || bytes > 1024 * 1024 - total) return 0;
        total += bytes;
        if (to < 0) continue;
        if (fgetxattr(to, name, NULL, 0, 0, 0) != bytes) return 0;
        const size_t capacity = bytes > 0 ? (size_t)bytes : 1;
        void *left = malloc(capacity), *right = malloc(capacity);
        const int equal = left && right && fgetxattr(from, name, left, capacity, 0, 0) == bytes
            && fgetxattr(to, name, right, capacity, 0, 0) == bytes && !memcmp(left, right, (size_t)bytes);
        free(left); free(right);
        if (!equal) return 0;
    }
    return 1;
}

static int acls_match(int from, int to) {
    errno = 0;
    acl_t original = acl_get_fd_np(from, ACL_TYPE_EXTENDED);
    const int original_error = errno;
    errno = 0;
    acl_t staged = acl_get_fd_np(to, ACL_TYPE_EXTENDED);
    const int staged_error = errno;
    int equal = !original && !staged && original_error == ENOENT && staged_error == ENOENT;
    if (original && staged) {
        const ssize_t size = acl_size(original);
        if (size > 0 && size <= 65536 && acl_size(staged) == size) {
            void *left = malloc((size_t)size), *right = malloc((size_t)size);
            equal = left && right && acl_copy_ext(left, original, size) == size
                && acl_copy_ext(right, staged, size) == size && !memcmp(left, right, (size_t)size);
            free(left); free(right);
        }
    }
    if (original) acl_free(original);
    if (staged) acl_free(staged);
    return equal;
}

static int same_file(const struct stat *left, const struct stat *right) {
    return shared_regular(left) && left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int same_snapshot(const struct stat *left, const struct stat *right) {
    return same_file(left, right) && left->st_size == right->st_size
        && left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec && left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static int replace_shared(const char *path, uintmax_t parent_dev, uintmax_t parent_ino,
                          const char *stage, uintmax_t stage_dev, uintmax_t stage_ino,
                          const char *target, uintmax_t target_dev, uintmax_t target_ino,
                          uintmax_t size, uintmax_t seconds, uintmax_t nanos, const char *recovery) {
    int parent = -1, original = -1, replacement = -1, error = ESTALE, swapped = 0;
    struct stat old_info, stage_info, current, named;
    parent = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY);
    if (parent < 0) { error = errno; goto done; }
    if (!owner_matches(parent, path, parent_dev, parent_ino)) goto done;
    original = openat(parent, target, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    replacement = openat(parent, stage, O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (original < 0 || replacement < 0 || fstat(original, &old_info) || fstat(replacement, &stage_info)
        || !shared_regular(&old_info) || !shared_regular(&stage_info)
        || !is_identity(&old_info, target_dev, target_ino) || !is_identity(&stage_info, stage_dev, stage_ino)
        || stage_info.st_size > 256 * 1024 || (uintmax_t)old_info.st_size != size || (uintmax_t)old_info.st_ctimespec.tv_sec != seconds
        || (uintmax_t)old_info.st_ctimespec.tv_nsec != nanos || old_info.st_flags != 0
        || (old_info.st_mode & (S_ISUID | S_ISGID))) goto done;
    if (!fstatat(parent, recovery, &named, AT_SYMLINK_NOFOLLOW)) { error = EEXIST; goto done; }
    if (errno != ENOENT) { error = errno; goto done; }
    // Bound the copy and require exact ACL and extended attribute equality before swapping names.
    if (!attributes_match(original, -1) || fchown(replacement, old_info.st_uid, old_info.st_gid)
        || fchmod(replacement, old_info.st_mode & 0777) || fcopyfile(original, replacement, NULL, COPYFILE_ACL | COPYFILE_XATTR)
        || !acls_match(original, replacement) || !attributes_match(original, replacement) || fsync(replacement)) {
        error = EACCES; goto done;
    }
    if (!owner_matches(parent, path, parent_dev, parent_ino)
        || fstatat(parent, target, &current, AT_SYMLINK_NOFOLLOW) || !same_snapshot(&current, &old_info)
        || fstatat(parent, stage, &named, AT_SYMLINK_NOFOLLOW) || !same_file(&named, &stage_info)
        || named.st_size != stage_info.st_size || named.st_mtimespec.tv_sec != stage_info.st_mtimespec.tv_sec
        || named.st_mtimespec.tv_nsec != stage_info.st_mtimespec.tv_nsec
        || named.st_mode != old_info.st_mode || named.st_gid != old_info.st_gid || named.st_flags != old_info.st_flags) goto done;
    test_barrier("before-shared-swap");
    if (renameatx_np(parent, stage, parent, target, RENAME_SWAP | RENAME_NOFOLLOW_ANY)) { error = errno; goto done; }
    swapped = 1;
    // The displaced inode survives at the stage name. Publish it to a unique visible
    // recovery name, even when a competing writer arrived immediately before the swap.
    if (!owner_matches(parent, path, parent_dev, parent_ino)
        || fstatat(parent, stage, &current, AT_SYMLINK_NOFOLLOW) || !shared_regular(&current)
        || fstatat(parent, target, &named, AT_SYMLINK_NOFOLLOW) || !same_file(&named, &stage_info)) goto done;
    const int expected = same_file(&current, &old_info) && current.st_size == old_info.st_size
        && current.st_mtimespec.tv_sec == old_info.st_mtimespec.tv_sec && current.st_mtimespec.tv_nsec == old_info.st_mtimespec.tv_nsec
        && current.st_mode == old_info.st_mode && current.st_gid == old_info.st_gid && current.st_flags == old_info.st_flags
        && acls_match(original, replacement) && attributes_match(original, replacement);
    if (exclusive_rename(parent, stage, recovery)) { error = errno; goto done; }
    if (fsync(parent) || !owner_matches(parent, path, parent_dev, parent_ino)
        || fstatat(parent, target, &named, AT_SYMLINK_NOFOLLOW) || !same_file(&named, &stage_info)
        || fstatat(parent, recovery, &named, AT_SYMLINK_NOFOLLOW) || !same_file(&named, &current) || !expected) goto done;
    error = 0;
done:
    if (replacement >= 0) close(replacement);
    if (original >= 0) close(original);
    if (parent >= 0) close(parent);
    if (error) return replacement_failure(error, !swapped);
    puts("{\"ok\":true}");
    return 0;
}
#endif

int main(int argc, char **argv) {
    uintmax_t parent_dev, parent_ino, source_dev, source_ino;
    const int editor_text = argc > 1 && !strcmp(argv[1], "--replace-shared-editor-text");
    if (editor_text || (argc > 1 && !strcmp(argv[1], "--replace-shared-text"))) {
#ifdef __APPLE__
        uintmax_t target_dev, target_ino, size, seconds, nanos;
        if (argc != 15 || argv[2][0] != '/' || !number(argv[3], &parent_dev) || !number(argv[4], &parent_ino)
            || !name_ok(argv[5]) || strncmp(argv[5], ".rerun-shared-replace-", 22)
            || !number(argv[6], &source_dev) || !number(argv[7], &source_ino) || !name_ok(argv[8]) || argv[8][0] == '.'
            || !number(argv[9], &target_dev) || !number(argv[10], &target_ino) || !number(argv[11], &size) || size > 256 * 1024
            || !number(argv[12], &seconds) || !number(argv[13], &nanos) || nanos >= 1000000000
            || !name_ok(argv[14]) || strncmp(argv[14], "shared-edit-recovery-", 21) || !strcmp(argv[8], argv[14])) return replacement_failure(EINVAL, 1);
        const char *suffix = strrchr(argv[8], '.');
        // The shared editor has already checked the file kind and complete UTF-8 bytes.
        // Both modes still pin the exact names and inodes before swapping them.
        if (!editor_text && (!suffix || (strcasecmp(suffix, ".txt") && strcasecmp(suffix, ".md")))) return replacement_failure(EINVAL, 1);
        return replace_shared(argv[2], parent_dev, parent_ino, argv[5], source_dev, source_ino, argv[8], target_dev, target_ino, size, seconds, nanos, argv[14]);
#else
        return replacement_failure(ENOTSUP, 1);
#endif
    }
    if (argc == 5 && !strcmp(argv[1], "--skill-lock")) {
        if (argv[2][0] != '/' || !number(argv[3], &parent_dev) || !number(argv[4], &parent_ino)) return failure(EINVAL);
        return skill_lock(argv[2], parent_dev, parent_ino);
    }
    if (argc != 8 || argv[1][0] != '/' || !number(argv[2], &parent_dev) || !number(argv[3], &parent_ino) ||
        !name_ok(argv[4]) || !number(argv[5], &source_dev) || !number(argv[6], &source_ino) || !name_ok(argv[7]) || !strcmp(argv[4], argv[7])) return failure(EINVAL);
    int flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
#ifdef __APPLE__
    flags |= O_NOFOLLOW_ANY;
#else
    flags |= O_NOFOLLOW;
#endif
    int fd = open(argv[1], flags);
    if (fd < 0) return failure(errno);
    struct stat source;
    if (!owner_matches(fd, argv[1], parent_dev, parent_ino)) { close(fd); return failure(ESTALE); }
    if (fstatat(fd, argv[4], &source, AT_SYMLINK_NOFOLLOW)) { int error = errno; close(fd); return failure(error); }
    if (!is_identity(&source, source_dev, source_ino) || (!S_ISREG(source.st_mode) && !S_ISDIR(source.st_mode))) { close(fd); return failure(ESTALE); }
    if (!owner_matches(fd, argv[1], parent_dev, parent_ino)) { close(fd); return failure(ESTALE); }
    test_barrier("before-rename");
    if (exclusive_rename(fd, argv[4], argv[7])) { int error = errno; close(fd); return failure(error); }
    struct stat moved;
    const int have_moved = !fstatat(fd, argv[7], &moved, AT_SYMLINK_NOFOLLOW);
    const int same_source = have_moved && is_identity(&moved, source_dev, source_ino);
    if (!same_source || !owner_matches(fd, argv[1], parent_dev, parent_ino)) {
        /* An atomic writer can replace the source after our check. Restore the inode we
         * actually moved, without replacing an arrival at the old name. Otherwise preserve
         * both entries for the app's journal; ESTALE never means that nothing moved. */
        struct stat current;
        test_barrier("before-rollback");
        if (have_moved && (S_ISREG(moved.st_mode) || S_ISDIR(moved.st_mode)) &&
            !fstatat(fd, argv[7], &current, AT_SYMLINK_NOFOLLOW) &&
            is_identity(&current, (uintmax_t)moved.st_dev, (uintmax_t)moved.st_ino)) (void)exclusive_rename(fd, argv[7], argv[4]);
        close(fd);
        return failure(ESTALE);
    }
    if (fsync(fd)) { int error = errno; close(fd); return failure(error); }
    close(fd);
    puts("{\"ok\":true}");
    return 0;
}

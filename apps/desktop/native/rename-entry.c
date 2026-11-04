#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
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
int main(int argc, char **argv) {
    uintmax_t parent_dev, parent_ino, source_dev, source_ino;
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
